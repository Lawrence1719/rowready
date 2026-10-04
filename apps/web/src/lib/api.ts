import { OPERATION_IDS, PRESETS, RECIPES, validateRecipeConfiguration, type RecipeCatalog, type RecipeConfiguration } from '@rowready/shared';

export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export const LOCAL_CATALOG: RecipeCatalog = { version: 1, recipes: PRESETS, operations: RECIPES };

export async function getCatalog(signal?: AbortSignal): Promise<RecipeCatalog> {
  const response = await fetch(`${API_URL}/api/recipes`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Recipe catalog unavailable');
  const catalog = await response.json() as RecipeCatalog;
  // Accept only the version and operation IDs understood by this client.
  if (catalog.version !== 1 || !Array.isArray(catalog.recipes) || !catalog.recipes.length || !Array.isArray(catalog.operations) || catalog.operations.length !== OPERATION_IDS.length) throw new Error('Unsupported recipe catalog');
  if (catalog.operations.some(operation => !OPERATION_IDS.includes(operation.id) || typeof operation.title !== 'string' || typeof operation.description !== 'string') || new Set(catalog.operations.map(operation => operation.id)).size !== OPERATION_IDS.length) throw new Error('Unsupported operations');
  const recipeIds = new Set<string>();
  for (const recipe of catalog.recipes) {
    if (typeof recipe.id !== 'string' || !recipe.id.trim() || recipeIds.has(recipe.id) || typeof recipe.name !== 'string' || typeof recipe.description !== 'string') throw new Error('Invalid recipe');
    if (recipe.profile !== 'general' && recipe.profile !== 'inventory') throw new Error('Unsupported recipe profile');
    recipeIds.add(recipe.id);
    validateRecipeConfiguration({ version: recipe.version, operations: recipe.operations });
  }
  if (!catalog.recipes.some(recipe => recipe.id === 'general-cleanup' && recipe.profile === 'general')) throw new Error('General cleanup preset unavailable');
  return catalog;
}
export async function validateRecipe(recipe: RecipeConfiguration): Promise<void> {
  // No file content, headers, filenames, or values are sent to the API.
  validateRecipeConfiguration(recipe);
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/recipes/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recipe), signal: AbortSignal.timeout(3000),
    });
  } catch { return; } // The local validator keeps an offline workspace fully usable.
  if (response.status >= 500 || response.status === 404) return;
  if (!response.ok) throw new Error('This recipe was rejected. Choose a preset and try again.');
}
