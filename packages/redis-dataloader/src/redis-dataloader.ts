import DataLoader, { BatchLoadFn } from 'dataloader';
import assert from 'assert';
import { CustomNotFound, RedisDataloaderOptionsRequired } from './interfaces';
import { NotFoundError } from '@ezweb/error';

export class RedisDataLoader<K, V, C = K> extends DataLoader<K, V, C> {
    private readonly name: string;
    private readonly options: DataLoader.Options<K, V, C> & CustomNotFound<K> & RedisDataloaderOptionsRequired<K, V>;
    private readonly underlyingBatchLoadFn: BatchLoadFn<K, V>;

    private static usedNames: string[] = [];
    private static NOT_FOUND_STRING = '___NOTFOUND___';

    constructor(name: string, batchLoadFn: BatchLoadFn<K, V>, options: DataLoader.Options<K, V, C> & CustomNotFound<K> & RedisDataloaderOptionsRequired<K, V>) {
        super((keys) => this.overridedBatchLoad(keys), { ...options, cache: false });
        this.underlyingBatchLoadFn = batchLoadFn;
        this.name = name + (options.redis.suffix ? `-${options.redis.suffix}` : '');
        this.options = options;

        if (RedisDataLoader.usedNames.includes(this.name)) {
            this.log(`WARNING this RedisDataLoader ${this.name} already exists`);
        } else {
            this.log(`New RedisDataLoader ${this.name}`);
            RedisDataLoader.usedNames.push(this.name);
        }
    }

    /**
     * @deprecated use clearAsync() instead
     */
    override clear(key: K): this {
        this.clearAsync(key);
        return this;
    }

    async clearAsync(...keys: K[]): Promise<number> {
        assert(keys.length, new Error('Empty array passed'));

        const done = await Promise.all(keys.map((key) => this.options.redis.client.del(this.redisKey(key))));
        return done.reduce((accumulator, currentValue) => accumulator + currentValue, 0);
    }

    /**
     * @deprecated use clearAllAsync() instead
     */
    override clearAll(): this {
        throw new Error('Cannot call clearAll on Index (use clearAllAsync)');
    }

    protected log(...args: unknown[]) {
        this.options.redis.logging?.(...args);
    }

    protected async overridedBatchLoad(keys: readonly K[]): Promise<(V | Error)[]> {
        /**
         * When the memoization cache is disabled,
         * your batch function will receive an array of keys which may contain duplicates!
         * Each key will be associated with each call to .load().
         * Your batch loader should provide a value for each instance of the requested key.
         *
         * Hence why we are deduplicating first
         */
        const uniqueRedisKeys = [...new Set(keys.map((key) => this.redisKey(key)))];
        const mapRedisKeyToModelKey: { redisKey: string; key: K; value: V | null | Error }[] = uniqueRedisKeys.map((rKey) => ({
            redisKey: rKey,
            key: keys.find((o) => this.redisKey(o) === rKey)!,
            value: null,
        }));

        // ⚠️ Cannot use MGET on a cluster
        // load cached values
        await Promise.all(
            mapRedisKeyToModelKey.map((entry) => {
                this.log('Reading from redis', entry.redisKey);
                return this.options.redis.client.get(entry.redisKey).then((data) => {
                    this.log('Redis returned', entry.redisKey, data);
                    if (data === RedisDataLoader.NOT_FOUND_STRING) {
                        entry.value = this.options.notFound?.(entry.key) ?? new NotFoundError(entry.key, 'Not found (redis cache)');
                    } else if (data !== null) {
                        entry.value = this.options.redis.deserialize(entry.key, data);
                    }
                });
            })
        );

        // this.log('map was', JSON.stringify(mapRedisKeyToModelKey));

        // keysToLoadFromDatasource is referencing mapRedisKeyToModelKey values
        const keysToLoadFromDatasource = mapRedisKeyToModelKey.filter(({ value }) => value === null);
        // load missing values from datastore
        if (keysToLoadFromDatasource.length > 0) {
            this.log(
                'Loading from datasource',
                keysToLoadFromDatasource.map(({ redisKey }) => redisKey)
            );
            const underlyingResults = await this.underlyingBatchLoadFn(keysToLoadFromDatasource.map(({ key }) => key));

            // Save freshly fetched data to redis
            await Promise.all(
                keysToLoadFromDatasource.map((entry, index) => {
                    // actually editing the reference (mapRedisKeyToModelKey)
                    entry.value = underlyingResults[index];

                    if (!(entry.value instanceof Error)) {
                        return this.store(entry.redisKey, entry.value);
                    } else if (entry.value instanceof NotFoundError) {
                        return this.storeNotFoundError(entry.redisKey);
                    }
                    return true;
                })
            );
        }

        this.log('map to be returned', mapRedisKeyToModelKey);
        return keys.map((key) => mapRedisKeyToModelKey.find(({ redisKey }) => redisKey === this.redisKey(key))!.value!);
    }

    private redisKey(key: K): string {
        return `${this.name}:${this.options.cacheKeyFn ? this.options.cacheKeyFn(key) : key}`;
    }

    override prime(key: K, value: Error | V) {
        this.primeAsync(key, value);
        return this;
    }

    primeAsync(key: K, value: Error | V): Promise<boolean> {
        if (!(value instanceof Error)) {
            return this.store(this.redisKey(key), value);
        }
        return Promise.resolve(false);
    }

    private store(rKey: string, value: V): Promise<boolean> {
        const rValue = this.options.redis.serialize(value);
        this.log('saving to redis', rKey, rValue);
        return this.options.redis.client.set(rKey, rValue, 'EX', this.options.redis.ttl).then((result) => result === 'OK');
    }

    private storeNotFoundError(rKey: string): Promise<boolean> {
        this.log('saving not found error to redis', rKey);
        return this.options.redis.client.set(rKey, RedisDataLoader.NOT_FOUND_STRING, 'EX', 60).then((result) => result === 'OK');
    }
}
