import { NotFoundError } from './not-found';
import { Model, ModelStatic } from 'sequelize';

export class ModelNotFoundError<M extends Model> extends NotFoundError {
    model: ModelStatic<M>;

    constructor(model: ModelStatic<M>, identifier: unknown) {
        super(identifier, `${model.name} not found for identifier ${JSON.stringify(identifier)}`);

        this.model = model;
    }

    override toJSON() {
        return {
            ...super.toJSON(),
            identifier: this.identifier,
        };
    }
}
