import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import request from 'supertest';
import { PRESETS, RECIPES } from '@rowready/shared';
import { createApplication } from '../dist/application.js';

let app;
let http;

before(async () => {
  app = await createApplication({ logger: false, allowedOrigins: ['http://localhost:5173', 'https://rowready.example'] });
  http = app.getHttpServer();
});

after(async () => {
  await app?.close();
});

test('health and the cached catalog are available without authentication', async () => {
  const health = await request(http).get('/api/health').expect(200);
  assert.deepEqual(health.body, { status: 'ok', service: 'rowready-api' });
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-powered-by'], undefined);

  const catalog = await request(http).get('/api/recipes').expect(200);
  assert.deepEqual(catalog.body, { version: 1, recipes: PRESETS, operations: RECIPES });
  assert.deepEqual(catalog.body.recipes.map(({ id, profile }) => ({ id, profile })), [
    { id: 'general-cleanup', profile: 'general' },
    { id: 'inventory-cleanup', profile: 'inventory' },
  ]);
  assert.deepEqual(catalog.body.recipes[0].operations, ['trim', 'duplicates']);
  assert.match(catalog.headers['cache-control'], /public, max-age=300/);
});

test('presets resolve by catalog ID and unknown IDs return 404', async () => {
  assert.ok(PRESETS.length > 0);
  const response = await request(http).get(`/api/recipes/${PRESETS[0].id}`).expect(200);
  assert.deepEqual(response.body, PRESETS[0]);
  const missing = await request(http).get('/api/recipes/not-a-real-preset').expect(404);
  assert.equal(missing.body.statusCode, 404);
});

test('validation preserves the explicit operation order', async () => {
  const recipe = { version: 1, operations: ['price', 'trim', 'sku'] };
  const response = await request(http).post('/api/recipes/validate').send(recipe).expect(200);
  assert.deepEqual(response.body, { valid: true, recipe });
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('optional operations validate by ID while all local settings remain outside the API contract', async () => {
  const recipe = { version: 1, operations: ['whitespace', 'case', 'replace', 'duplicatesByKey'] };
  const response = await request(http).post('/api/recipes/validate').send(recipe).expect(200);
  assert.deepEqual(response.body, { valid: true, recipe });
  for (const extra of [
    { options: { replace: { columns: [0], find: 'PRIVATE CELL VALUE', replacement: 'other' } } },
    { columns: [0] },
    { find: 'PRIVATE CELL VALUE' },
    { replacement: 'PRIVATE CELL VALUE' },
  ]) {
    const rejected = await request(http).post('/api/recipes/validate').send({ ...recipe, ...extra }).expect(400);
    assert.doesNotMatch(JSON.stringify(rejected.body), /PRIVATE CELL VALUE/);
  }
});

test('validation rejects unsupported versions, operations, shapes, and file fields', async () => {
  const cases = [
    {},
    [],
    { version: '1', operations: ['trim'] },
    { version: 2, operations: ['trim'] },
    { version: 1 },
    { version: 1, operations: [] },
    { version: 1, operations: 'trim' },
    { version: 1, operations: ['trim', 'trim'] },
    { version: 1, operations: ['upload'] },
    { version: 1, operations: [{ id: 'trim' }] },
    { version: 1, operations: ['trim'], fileContents: 'PRIVATE CSV DATA' },
    { version: 1, operations: ['trim'], headers: ['PRIVATE CSV DATA'] },
    { version: 1, operations: ['trim'], rows: [['PRIVATE CSV DATA']] },
    { version: 1, operations: ['trim'], profile: 'inventory' },
    JSON.parse('{"version":1,"operations":["trim"],"__proto__":{"data":"PRIVATE CSV DATA"}}'),
    { version: 1, operations: ['trim'], constructor: 'PRIVATE CSV DATA' },
  ];

  for (const body of cases) {
    const response = await request(http).post('/api/recipes/validate').send(body).expect(400);
    assert.equal(response.body.statusCode, 400);
    assert.equal(response.body.error, 'Bad Request');
    assert.ok(Array.isArray(response.body.message));
    assert.ok(response.body.message.length > 0);
    assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE CSV DATA/);
  }
});

test('malformed JSON is a clean 400 and oversized JSON is limited to 16 KiB', async () => {
  const malformed = await request(http).post('/api/recipes/validate')
    .set('Content-Type', 'application/json')
    .send('{"version":1,"operations":["PRIVATE CSV DATA"')
    .expect(400);
  assert.deepEqual(malformed.body, {
    statusCode: 400,
    error: 'Bad Request',
    message: ['Request body must contain valid JSON'],
  });

  const oversized = await request(http).post('/api/recipes/validate')
    .send({ version: 1, operations: ['trim'], fileContents: 'x'.repeat(17 * 1024) })
    .expect(413);
  assert.equal(oversized.body.error, 'Payload Too Large');
  assert.deepEqual(oversized.body.message, ['JSON body must not exceed 16 KiB']);

  await request(http).post('/api/recipes/validate')
    .set('Content-Type', 'text/csv')
    .send('PRIVATE CSV DATA')
    .expect(400);
});

test('CORS reflects only configured origins and never allows credentials', async () => {
  const allowed = await request(http).options('/api/recipes/validate')
    .set('Origin', 'https://rowready.example')
    .set('Access-Control-Request-Method', 'POST')
    .expect(204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://rowready.example');
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  assert.match(allowed.headers['access-control-allow-methods'], /POST/);

  const denied = await request(http).get('/api/recipes').set('Origin', 'https://other.example').expect(200);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal(denied.headers['access-control-allow-credentials'], undefined);
});

test('default CORS supports both local Vite addresses', async () => {
  const previousOrigins = process.env.WEB_ORIGINS;
  delete process.env.WEB_ORIGINS;
  let defaultApp;
  try {
    defaultApp = await createApplication({ logger: false });
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const response = await request(defaultApp.getHttpServer()).get('/api/recipes').set('Origin', origin).expect(200);
      assert.equal(response.headers['access-control-allow-origin'], origin);
    }
  } finally {
    await defaultApp?.close();
    if (previousOrigins === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = previousOrigins;
  }
});

test('OpenAPI and Swagger UI describe the bounded API contract', async () => {
  const response = await request(http).get('/api/docs-json').expect(200);
  const document = response.body;
  assert.ok(document.paths['/api/health'].get);
  assert.ok(document.paths['/api/recipes'].get);
  assert.ok(document.paths['/api/recipes/{id}'].get);
  assert.ok(document.paths['/api/recipes/validate'].post);
  const schema = document.components.schemas.RecipeConfigurationDto;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.version.enum, [1]);
  assert.equal(schema.properties.operations.uniqueItems, true);
  assert.equal(schema.properties.operations.minItems, 1);
  assert.equal(schema.properties.profile, undefined);
  assert.deepEqual(document.components.schemas.RecipePresetDto.properties.profile.enum, ['general', 'inventory']);
  assert.ok(document.components.schemas.RecipePresetDto.required.includes('profile'));
  const docs = await request(http).get('/api/docs').expect(200);
  assert.match(docs.text, /swagger-ui/);
});
