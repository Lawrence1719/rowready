import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { RecipesModule } from './recipes/recipes.module.js';

@Module({ imports: [HealthModule, RecipesModule] })
export class AppModule {}
