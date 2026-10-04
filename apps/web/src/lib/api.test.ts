// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS, RECIPES, type RecipeCatalog, type RecipeConfiguration } from '@rowready/shared';
import { API_URL, getCatalog, LOCAL_CATALOG, validateRecipe } from './api';

const fetchMock = vi.fn<typeof fetch>();

function catalog(): RecipeCatalog {
  return structuredClone({ version: 1, recipes: PRESETS, operations: RECIPES });
}

function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('recipe validation requests', () => {
  it('sends only recipe version and operation IDs as JSON', async () => {
    const configuration: RecipeConfiguration = { version: 1, operations: ['trim', 'price'] };
    respond({ valid: true, recipe: configuration });
    await expect(validateRecipe(configuration)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/recipes/validate`);
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, operations: ['trim', 'price'] }),
    });
    expect(Object.keys(JSON.parse(options?.body as string))).toEqual(['version', 'operations']);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('validates locally before sending a request, including rejecting file-related fields', async () => {
    const invalid: unknown[] = [
      { version: 2, operations: ['trim'] },
      { version: 1, operations: [] },
      { version: 1, operations: ['unknown'] },
      { version: 1, operations: ['trim', 'trim'] },
      { version: 1, operations: ['trim'], filename: 'private.csv' },
      { version: 1, operations: ['trim'], rows: [['private inventory']] },
      { version: 1, operations: ['trim'], headers: ['private header'] },
    ];
    for (const configuration of invalid) {
      await expect(validateRecipe(configuration as RecipeConfiguration)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses local validation when the network is unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(validateRecipe({ version: 1, operations: ['trim'] })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses local validation when a request times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    await expect(validateRecipe({ version: 1, operations: ['price'] })).resolves.toBeUndefined();
  });

  it.each([404, 500, 503])('uses local validation when the service returns %i', async (status) => {
    respond({ message: 'Unavailable' }, status);
    await expect(validateRecipe({ version: 1, operations: ['trim'] })).resolves.toBeUndefined();
  });

  it.each([400, 401, 422])('shows an explicit service rejection for status %i', async (status) => {
    respond({ message: 'Rejected' }, status);
    await expect(validateRecipe({ version: 1, operations: ['trim'] })).rejects.toThrow('This recipe was rejected');
  });
});

describe('recipe catalog requests', () => {
  it('loads a valid catalog with a bounded, cancellable request and no inventory payload', async () => {
    const expected = catalog();
    const controller = new AbortController();
    respond(expected);
    await expect(getCatalog(controller.signal)).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/recipes`);
    expect(options?.body).toBeUndefined();
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
    controller.abort();
    expect(options?.signal?.aborted).toBe(true);
  });

  it('keeps the bundled catalog available when a remote catalog cannot load', async () => {
    const before = structuredClone(LOCAL_CATALOG);
    fetchMock.mockRejectedValue(new TypeError('Offline'));
    await expect(getCatalog()).rejects.toThrow('Offline');
    expect(LOCAL_CATALOG).toEqual(before);
    expect(LOCAL_CATALOG).toEqual({ version: 1, recipes: PRESETS, operations: RECIPES });
    expect(LOCAL_CATALOG.recipes).toHaveLength(2);
    expect(LOCAL_CATALOG.recipes[0]).toMatchObject({ id: 'general-cleanup', profile: 'general', operations: ['trim', 'duplicates'] });
  });

  it('rejects unsuccessful responses and invalid JSON', async () => {
    respond({ message: 'Unavailable' }, 503);
    await expect(getCatalog()).rejects.toThrow('Recipe catalog unavailable');
    fetchMock.mockResolvedValue(new Response('not JSON', { status: 200 }));
    await expect(getCatalog()).rejects.toThrow();
  });

  it.each([
    ['null', () => null],
    ['unsupported version', () => ({ ...catalog(), version: 2 })],
    ['string version', () => ({ ...catalog(), version: '1' })],
    ['missing recipes', () => ({ version: 1, operations: RECIPES })],
    ['empty recipes', () => ({ ...catalog(), recipes: [] })],
    ['missing operations', () => ({ version: 1, recipes: PRESETS })],
    ['missing operation', () => ({ ...catalog(), operations: RECIPES.slice(1) })],
    ['duplicate operation ID', () => ({ ...catalog(), operations: RECIPES.map(() => RECIPES[0]) })],
    ['unknown operation ID', () => ({ ...catalog(), operations: [{ ...RECIPES[0], id: 'unknown' }, ...RECIPES.slice(1)] })],
    ['invalid operation title', () => ({ ...catalog(), operations: [{ ...RECIPES[0], title: 42 }, ...RECIPES.slice(1)] })],
    ['invalid operation description', () => ({ ...catalog(), operations: [{ ...RECIPES[0], description: null }, ...RECIPES.slice(1)] })],
    ['empty recipe ID', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], id: ' ' }] })],
    ['duplicate recipe ID', () => ({ ...catalog(), recipes: [PRESETS[0], { ...PRESETS[1], id: PRESETS[0].id }] })],
    ['invalid recipe ID', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], id: 42 }] })],
    ['invalid recipe name', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], name: null }] })],
    ['invalid recipe description', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], description: false }] })],
    ['missing recipe profile', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], profile: undefined }] })],
    ['unsupported recipe profile', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], profile: 'contacts' }] })],
    ['missing general preset', () => ({ ...catalog(), recipes: [PRESETS[1]] })],
    ['unsupported recipe version', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], version: 2 }] })],
    ['empty recipe operations', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], operations: [] }] })],
    ['duplicate recipe operations', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], operations: ['trim', 'trim'] }] })],
    ['unknown recipe operation', () => ({ ...catalog(), recipes: [{ ...PRESETS[0], operations: ['unknown'] }] })],
  ])('rejects a malformed catalog: %s', async (_label, makeCatalog) => {
    respond(makeCatalog());
    await expect(getCatalog()).rejects.toThrow();
  });
});
