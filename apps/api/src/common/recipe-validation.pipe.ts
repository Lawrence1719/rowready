import { BadRequestException, Injectable, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';

/** Check raw keys before class-transformer can discard special object properties. */
@Injectable()
export class RecipeValidationPipe extends ValidationPipe {
  constructor() {
    super({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      exceptionFactory: (errors) => new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: errors.flatMap((error) => Object.values(error.constraints ?? {})),
      }),
    });
  }

  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(['A recipe must be a JSON object']);
    }

    if (Object.keys(value).some((key) => key !== 'version' && key !== 'operations')) {
      throw new BadRequestException(['Only version and operations are accepted; do not send file contents']);
    }

    return super.transform(value, metadata);
  }
}
