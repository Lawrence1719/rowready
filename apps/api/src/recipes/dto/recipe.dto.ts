import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, Equals, IsArray, IsIn } from 'class-validator';
import { OPERATION_IDS, type AnalysisProfile, type OperationId, type RecipeConfiguration } from '@rowready/shared';

export class RecipeConfigurationDto implements RecipeConfiguration {
  @ApiProperty({ type: 'integer', enum: [1], description: 'Recipe format version.' })
  @Equals(1, { message: 'version must be 1' })
  version!: 1;

  @ApiProperty({
    type: 'array',
    items: { type: 'string', enum: [...OPERATION_IDS] },
    minItems: 1,
    maxItems: OPERATION_IDS.length,
    uniqueItems: true,
    example: ['trim', 'duplicates'],
    description: 'Supported cleanup operations. File contents are never accepted.',
  })
  @IsArray({ message: 'operations must be an array' })
  @ArrayNotEmpty({ message: 'operations must contain at least one operation' })
  @ArrayMaxSize(OPERATION_IDS.length, { message: 'operations contains too many entries' })
  @ArrayUnique({ message: 'operations must not contain duplicates' })
  @IsIn(OPERATION_IDS, { each: true, message: 'operations must contain only supported operation IDs' })
  operations!: OperationId[];
}

export class RecipePresetDto extends RecipeConfigurationDto {
  @ApiProperty({ description: 'Stable preset identifier.' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ enum: ['general', 'inventory'], description: 'Local review rules used by this preset. Only operation IDs are sent for validation.' })
  profile!: AnalysisProfile;
}

export class OperationDefinitionDto {
  @ApiProperty({ enum: [...OPERATION_IDS] })
  id!: OperationId;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;
}

export class RecipeCatalogDto {
  @ApiProperty({ type: 'integer', enum: [1] })
  version!: 1;

  @ApiProperty({ type: [RecipePresetDto] })
  recipes!: RecipePresetDto[];

  @ApiProperty({ type: [OperationDefinitionDto] })
  operations!: OperationDefinitionDto[];
}

export class RecipeValidationDto {
  @ApiProperty({ type: 'boolean', enum: [true] })
  valid!: true;

  @ApiProperty({ type: RecipeConfigurationDto })
  recipe!: RecipeConfigurationDto;
}

export class ValidationErrorDto {
  @ApiProperty({ type: 'integer', example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({ type: [String], example: ['version must be 1'] })
  message!: string[];
}
