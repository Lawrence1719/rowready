import { OPERATION_IDS } from './types.js';
import type { OperationDefinition, OperationId, RecipeConfiguration, RecipePreset } from './types.js';

export const RECIPES: OperationDefinition[] = [
  { id: 'trim', title: 'Trim extra spaces', description: 'Tidy the edges of every cell' },
  { id: 'whitespace', title: 'Normalize repeated spaces', description: 'Collapse repeated spaces in chosen columns; keep tabs and line breaks' },
  { id: 'case', title: 'Change text casing', description: 'Use lowercase, uppercase, or title case in chosen columns' },
  { id: 'replace', title: 'Find and replace', description: 'Replace exact text in chosen columns; matching is case-sensitive' },
  { id: 'sku', title: 'Standardize SKUs', description: 'Use consistent uppercase codes' },
  { id: 'category', title: 'Unify categories', description: 'Match casing across categories' },
  { id: 'price', title: 'Clean price formatting', description: 'Remove symbols and thousands commas' },
  { id: 'duplicates', title: 'Remove exact duplicates', description: 'Keep the first identical row' },
  { id: 'duplicatesByKey', title: 'Duplicates by column', description: 'Keep the first matching key; retain rows with blank keys' },
];

export const PRESETS: RecipePreset[] = [
  {
    id: 'general-cleanup',
    name: 'General cleanup',
    description: 'Trim cell edges, remove identical rows, and review empty values.',
    version: 1,
    profile: 'general',
    operations: ['trim', 'duplicates'],
  },
  {
    id: 'inventory-cleanup',
    name: 'Inventory cleanup',
    description: 'Tidy inventory formatting and remove identical rows.',
    version: 1,
    profile: 'inventory',
    operations: ['trim', 'sku', 'category', 'price', 'duplicates'],
  },
];

function isOperationId(value: unknown): value is OperationId {
  return OPERATION_IDS.some((id) => value === id);
}

export function validateRecipeConfiguration(input: unknown): RecipeConfiguration {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Recipe configuration must be an object.');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'version' && key !== 'operations') {
      throw new Error(`Unknown recipe configuration field: ${String(key)}.`);
    }
  }
  const configuration = input as Record<string, unknown>;
  if (!Object.hasOwn(configuration, 'version') || configuration.version !== 1) {
    throw new Error('Recipe version must be 1.');
  }
  if (!Object.hasOwn(configuration, 'operations') || !Array.isArray(configuration.operations) || configuration.operations.length === 0) {
    throw new Error('Recipe operations must be a nonempty array.');
  }
  const operations: OperationId[] = [];
  const seen = new Set<OperationId>();
  for (const operation of configuration.operations) {
    if (!isOperationId(operation)) {
      throw new Error(`Unknown recipe operation. Use only: ${OPERATION_IDS.join(', ')}.`);
    }
    if (seen.has(operation)) {
      throw new Error(`Recipe operations must be unique. Duplicate operation: ${operation}.`);
    }
    seen.add(operation);
    operations.push(operation);
  }
  return { version: 1, operations };
}
