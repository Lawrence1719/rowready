import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PRESETS,
  RECIPES,
  validateRecipeConfiguration,
  type RecipeCatalog,
  type RecipeConfiguration,
  type RecipePreset,
  type RecipeValidation,
} from '@rowready/shared';

@Injectable()
export class RecipesService {
  catalog(): RecipeCatalog {
    return { version: 1, recipes: PRESETS, operations: RECIPES };
  }

  findById(id: string): RecipePreset {
    const recipe = PRESETS.find((preset) => preset.id === id);
    if (!recipe) throw new NotFoundException('Recipe preset not found');
    return recipe;
  }

  validate(recipe: RecipeConfiguration): RecipeValidation {
    try {
      const configuration = { version: recipe.version, operations: [...recipe.operations] };
      return { valid: true, recipe: validateRecipeConfiguration(configuration) };
    } catch {
      // Keep shared/client rules authoritative without reflecting submitted data in failures.
      throw new BadRequestException(['Recipe configuration is not supported']);
    }
  }
}
