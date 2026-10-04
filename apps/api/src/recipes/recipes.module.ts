import { Module } from '@nestjs/common';
import { RecipeValidationPipe } from '../common/recipe-validation.pipe.js';
import { RecipesController } from './recipes.controller.js';
import { RecipesService } from './recipes.service.js';

@Module({
  controllers: [RecipesController],
  providers: [RecipesService, RecipeValidationPipe],
})
export class RecipesModule {}
