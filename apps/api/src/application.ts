import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type LoggerService, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { AppModule } from './app.module.js';

const require = createRequire(import.meta.url);
// Explicit file references let serverless tracing include Swagger's static assets.
const swaggerAssets = [
  ['swagger-ui.css', 'text/css', readFileSync(require.resolve('swagger-ui-dist/swagger-ui.css'))],
  ['swagger-ui-bundle.js', 'application/javascript', readFileSync(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'))],
  ['swagger-ui-standalone-preset.js', 'application/javascript', readFileSync(require.resolve('swagger-ui-dist/swagger-ui-standalone-preset.js'))],
  ['favicon-32x32.png', 'image/png', readFileSync(require.resolve('swagger-ui-dist/favicon-32x32.png'))],
  ['favicon-16x16.png', 'image/png', readFileSync(require.resolve('swagger-ui-dist/favicon-16x16.png'))],
] as const;

export interface ApplicationOptions {
  logger?: LoggerService | LogLevel[] | false;
  allowedOrigins?: string[];
}

function allowedOriginsFromEnvironment(): string[] {
  const configured = process.env.WEB_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173';
  return configured.split(',').map((origin) => origin.trim()).filter(Boolean);
}

const jsonErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
  if (typeof type !== 'string' || !type.startsWith('entity.')) return next(error);

  const statusCode = type === 'entity.too.large' ? 413 : 400;
  response.status(statusCode).json({
    statusCode,
    error: statusCode === 413 ? 'Payload Too Large' : 'Bad Request',
    message: [statusCode === 413 ? 'JSON body must not exceed 16 KiB' : 'Request body must contain valid JSON'],
  });
};

/** Build an initialized app without opening a port, so tests can exercise the actual HTTP pipeline. */
export async function createApplication(options: ApplicationOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: options.logger ?? ['error', 'warn', 'log'],
  });
  return configureApplication(app, options);
}

/** Apply the same HTTP configuration to production and test application instances. */
export async function configureApplication(app: NestExpressApplication, options: ApplicationOptions = {}): Promise<NestExpressApplication> {
  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableCors({
    origin: options.allowedOrigins ?? allowedOriginsFromEnvironment(),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 600,
  });

  // No URL-encoded, multipart, or file-upload parser is installed.
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use(jsonErrorHandler);

  const documentation = new DocumentBuilder()
    .setTitle('RowReady recipe API')
    .setDescription('General spreadsheet cleanup and optional inventory presets. File processing stays in the browser; this API only lists presets and validates operation IDs.')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, documentation);
  // The HTTP validator rejects unknown properties; express the same contract in OpenAPI.
  const configurationSchema = document.components?.schemas?.RecipeConfigurationDto;
  if (configurationSchema && !('$ref' in configurationSchema)) configurationSchema.additionalProperties = false;
  const server: express.Express = app.getHttpAdapter().getInstance();
  for (const [filename, contentType, contents] of swaggerAssets) {
    server.get(`/api/docs/${filename}`, (_request: Request, response: Response) => {
      response.type(contentType).send(contents);
    });
  }
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    customSiteTitle: 'RowReady API',
    swaggerOptions: { persistAuthorization: false },
  });

  await app.init();
  return app;
}
