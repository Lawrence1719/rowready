import assert from 'node:assert/strict';
import { test } from 'vitest';
import { OPERATION_IDS, PRESETS, RECIPES, validateRecipeConfiguration } from '../src/index.js';

test('preset configurations use the supported operations', () => {
  assert.deepEqual(RECIPES.map((operation) => operation.id), OPERATION_IDS);
  assert.deepEqual(PRESETS.map(({ id, profile, operations }) => ({ id, profile, operations })), [
    { id: 'general-cleanup', profile: 'general', operations: ['trim', 'duplicates'] },
    { id: 'inventory-cleanup', profile: 'inventory', operations: ['trim', 'sku', 'category', 'price', 'duplicates'] },
  ]);
  for (const preset of PRESETS) {
    assert.deepEqual(validateRecipeConfiguration({ version: preset.version, operations: preset.operations }), {
      version: 1,
      operations: preset.operations,
    });
  }
});

test('recipe validation returns an independent configuration in the selected order', () => {
  const input = { version: 1, operations: ['price', 'trim'] };
  const result = validateRecipeConfiguration(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.operations, input.operations);
  input.operations.push('duplicates');
  assert.deepEqual(result.operations, ['price', 'trim']);
});

test('recipe validation rejects nonobjects and missing or unsupported versions', () => {
  for (const value of [null, undefined, true, 'recipe', [], 1]) {
    assert.throws(() => validateRecipeConfiguration(value), /must be an object/);
  }
  for (const version of [undefined, 0, 2, '1', null]) {
    assert.throws(() => validateRecipeConfiguration({ version, operations: ['trim'] }), /version must be 1/);
  }
  assert.throws(() => validateRecipeConfiguration({ operations: ['trim'] }), /version must be 1/);
  assert.throws(() => validateRecipeConfiguration(Object.create({ version: 1, operations: ['trim'] })), /version must be 1/);
});

test('recipe validation requires at least one unique supported operation', () => {
  for (const operations of [undefined, null, 'trim', [], [''], ['unknown'], ['trim', 1], ['trim', 'trim']]) {
    assert.throws(() => validateRecipeConfiguration({ version: 1, operations }), /operations|operation/);
  }
  assert.throws(() => validateRecipeConfiguration({ version: 1 }), /nonempty array/);
  assert.throws(() => validateRecipeConfiguration({ version: 1, operations: Array(1) }), /Unknown recipe operation/);
});

test('recipe validation rejects unknown keys, including prototype-related keys', () => {
  for (const key of ['name', 'id', 'profile', 'rows', '__proto__', 'constructor', 'prototype']) {
    const input = JSON.parse(`{"version":1,"operations":["trim"],"${key}":true}`);
    assert.throws(() => validateRecipeConfiguration(input), /Unknown recipe configuration field/);
  }
  assert.throws(() => validateRecipeConfiguration({ version: 1, operations: ['trim'], [Symbol('extra')]: true }), /Unknown recipe configuration field/);
});
