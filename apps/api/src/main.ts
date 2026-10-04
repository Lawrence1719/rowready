import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApplication } from './application.js';

async function bootstrap(): Promise<void> {
  // Keep Nest creation in the entrypoint so Vercel can detect the framework.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });
  await configureApplication(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
