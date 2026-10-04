import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { RecipeCatalog, RecipePreset, RecipeValidation } from '@rowready/shared';
import { RecipeValidationPipe } from '../common/recipe-validation.pipe.js';
import {
  RecipeCatalogDto,
  RecipeConfigurationDto,
  RecipePresetDto,
  RecipeValidationDto,
  ValidationErrorDto,
} from './dto/recipe.dto.js';
import { RecipesService } from './recipes.service.js';

const CATALOG_CACHE = 'public, max-age=300, stale-while-revalidate=3600';

@ApiTags('recipes')
@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  @Header('Cache-Control', CATALOG_CACHE)
  @ApiOperation({ summary: 'List bundled presets and supported operations' })
  @ApiOkResponse({ type: RecipeCatalogDto })
  catalog(): RecipeCatalog {
    return this.recipes.catalog();
  }

  @Get(':id')
  @Header('Cache-Control', CATALOG_CACHE)
  @ApiOperation({ summary: 'Get a bundled recipe preset' })
  @ApiParam({ name: 'id', description: 'A preset ID from the recipe catalog.' })
  @ApiOkResponse({ type: RecipePresetDto })
  @ApiNotFoundResponse({ description: 'No preset has this ID.' })
  findById(@Param('id') id: string): RecipePreset {
    return this.recipes.findById(id);
  }

  @Post('validate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Validate a recipe configuration',
    description: 'Accepts only a version and operation IDs. Never send spreadsheet files, rows, headers, or cell values. Maximum JSON body size: 16 KiB.',
  })
  @ApiBody({ type: RecipeConfigurationDto })
  @ApiOkResponse({ type: RecipeValidationDto })
  @ApiBadRequestResponse({ description: 'Invalid JSON or recipe configuration.', type: ValidationErrorDto })
  @ApiResponse({ status: 413, description: 'JSON body exceeds 16 KiB.', type: ValidationErrorDto })
  validate(@Body(RecipeValidationPipe) recipe: RecipeConfigurationDto): RecipeValidation {
    return this.recipes.validate(recipe);
  }
}
