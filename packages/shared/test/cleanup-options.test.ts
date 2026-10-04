import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  cleanData, parseCSV, validateCleanupOptions, MAX_REPLACE_TEXT_LENGTH, MAX_CELL_CHARACTERS,
  type CleanupOptions, type CsvDataset, type OperationId,
} from '../src/index.js';

function table(cells: string[][]): CsvDataset {
  return { headers: cells[0]!.map((_, col) => `Column ${col + 1}`), delimiter: ',', rows: cells.map((row, index) => ({ id: index + 1, cells: row })) };
}

test('space normalization is scoped and preserves tabs, newlines, and single nonbreaking spaces', () => {
  const data = table([['  A   B\u00a0\u00a0C\t\tD\n\nE\u00a0F  ', ' A   B ']]);
  const result = cleanData(data, ['whitespace'], { whitespace: { columns: [0] } });
  assert.deepEqual(result.data.rows[0]!.cells, [' A B C\t\tD\n\nE\u00a0F ', ' A   B ']);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.col, 0);
});

test('lowercase, uppercase, and title case affect only selected columns without trimming', () => {
  const data = table([['  éLÈNE\tSMITH-jONES\nSECOND LINE ', 'aBc', '00123']]);
  for (const [mode, expected] of [
    ['lower', '  élène\tsmith-jones\nsecond line '],
    ['upper', '  ÉLÈNE\tSMITH-JONES\nSECOND LINE '],
    ['title', '  Élène\tSmith-Jones\nSecond Line '],
  ] as const) {
    const result = cleanData(data, ['case'], { case: { columns: [0, 2], mode } });
    assert.deepEqual(result.data.rows[0]!.cells, [expected, 'aBc', '00123']);
    assert.equal(result.changes.length, 1);
  }
});

test('find and replace uses literal case-sensitive matches and replacement text', () => {
  const data = table([['a.b A.B a.b.* a.b', 'a.b'], ['aaaa', 'unchanged']]);
  const result = cleanData(data, ['replace'], { replace: { columns: [0], find: 'a.b', replacement: '$&\\1' } });
  assert.deepEqual(result.data.rows[0]!.cells, ['$&\\1 A.B $&\\1.* $&\\1', 'a.b']);
  assert.deepEqual(result.data.rows[1]!.cells, ['aaaa', 'unchanged']);
  const removed = cleanData(data, ['replace'], { replace: { columns: [0], find: 'aa', replacement: '' } });
  assert.deepEqual(removed.data.rows[1]!.cells, ['', 'unchanged']);
  assert.equal(data.rows[0]!.cells[0], 'a.b A.B a.b.* a.b');
});

test('transforms have deterministic trim-space-case-replace-inventory order independent of selection order', () => {
  const data = parseCSV('SKU,Price,Category,Notes\n  ab   cd ,$001.20,hOME   OFFICE, Unchanged ');
  const operations: OperationId[] = ['trim', 'whitespace', 'case', 'replace', 'sku', 'price', 'category'];
  const options: CleanupOptions = {
    whitespace: { columns: [0, 2] },
    case: { columns: [0, 2], mode: 'lower' },
    replace: { columns: [0, 2], find: ' ', replacement: '-' },
  };
  const result = cleanData(data, operations, options);
  assert.deepEqual(result.data.rows[0]!.cells, ['AB-CD', '1.20', 'Home-Office', 'Unchanged']);
  assert.deepEqual(cleanData(data, [...operations].reverse(), options), result);
});

test('key duplicates use transformed selected columns, retain first, and keep differing unselected values only on the first row', () => {
  const data = parseCSV('Email,Name,Note\n A@example.com ,Ana,first\na@example.com,Ana,second\na@example.com,Bo,third\nB@example.com,Ana,fourth');
  const result = cleanData(data, ['trim', 'case', 'duplicatesByKey'], {
    case: { columns: [0], mode: 'lower' }, duplicatesByKey: { columns: [0, 1] },
  });
  assert.deepEqual(result.data.rows.map(row => row.id), [1, 3, 4]);
  assert.deepEqual(result.removed, [data.rows[1]]);
  assert.deepEqual(result.data.rows[0]!.cells, ['a@example.com', 'Ana', 'first']);
  assert.ok(result.changes.every(change => change.rowId !== 2));
});

test('key duplicates skip every row with any blank key and never coerce numeric strings', () => {
  const data = table([
    ['', 'A'], ['', 'A'], ['   ', 'A'], ['   ', 'A'], ['001', ''], ['001', ''], ['001', 'A'], ['1', 'A'], ['001', 'A'],
  ]);
  const result = cleanData(data, ['duplicatesByKey'], { duplicatesByKey: { columns: [0, 1] } });
  assert.deepEqual(result.data.rows.map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(result.removed.map(row => row.id), [9]);
  assert.equal(result.changes.length, 0);
});

test('key tuples cannot collide through separators and independent exact dedup still handles blank rows', () => {
  const data = table([['a|b', 'c'], ['a', 'b|c'], ['', ''], ['', ''], ['a|b', 'c']]);
  const result = cleanData(data, ['duplicatesByKey', 'duplicates'], { duplicatesByKey: { columns: [0, 1] } });
  assert.deepEqual(result.data.rows.map(row => row.id), [1, 2, 3]);
  assert.deepEqual(result.removed.map(row => row.id), [4, 5]);
});

test('each enabled configurable operation requires unique valid columns from the current file', () => {
  const data = table([['one', 'two']]);
  for (const operation of ['whitespace', 'case', 'replace', 'duplicatesByKey'] as const) {
    assert.throws(() => cleanData(data, [operation]), /choose at least one column/);
    for (const columns of [[], [0, 0], [-1], [2], [0.5], [NaN], ['0'], Array(1)]) {
      const options = { [operation]: { columns, mode: 'lower', find: 'one', replacement: 'two' } } as CleanupOptions;
      assert.throws(() => validateCleanupOptions(data, [operation], options), /column/);
    }
  }
  assert.throws(() => validateCleanupOptions(data, ['case'], { case: { columns: [0], mode: 'invalid' } } as unknown as CleanupOptions), /choose lowercase/);
  assert.doesNotThrow(() => validateCleanupOptions(data, ['trim'], { replace: { columns: [], find: '', replacement: '' } }));
});

test('replacement settings reject empty or oversized searches and nontext or oversized replacements', () => {
  const data = table([['one']]);
  for (const find of ['', null, 1, 'x'.repeat(MAX_REPLACE_TEXT_LENGTH + 1)]) {
    assert.throws(() => cleanData(data, ['replace'], { replace: { columns: [0], find, replacement: '' } } as CleanupOptions), /characters to find/);
  }
  for (const replacement of [null, 1, 'x'.repeat(MAX_REPLACE_TEXT_LENGTH + 1)]) {
    assert.throws(() => cleanData(data, ['replace'], { replace: { columns: [0], find: 'one', replacement } } as CleanupOptions), /replacement must be text/);
  }
  assert.doesNotThrow(() => validateCleanupOptions(data, ['replace'], { replace: { columns: [0], find: 'x'.repeat(MAX_REPLACE_TEXT_LENGTH), replacement: '' } }));
});

test('replacement expansion is bounded before allocation and Unicode casing respects the cell limit', () => {
  const data = table([['small'], ['a'.repeat(MAX_CELL_CHARACTERS)]]);
  const before = JSON.stringify(data);
  assert.throws(() => cleanData(data, ['replace'], { replace: { columns: [0], find: 'a', replacement: 'b'.repeat(MAX_REPLACE_TEXT_LENGTH) } }), /Row 2.*100,000 character cell limit/);
  assert.equal(JSON.stringify(data), before);
  const caseData = table([['ß'.repeat(MAX_CELL_CHARACTERS)]]);
  assert.throws(() => cleanData(caseData, ['case'], { case: { columns: [0], mode: 'upper' } }), /100,000 character cell limit/);
  assert.equal(caseData.rows[0]!.cells[0], 'ß'.repeat(MAX_CELL_CHARACTERS));
  const boundary = cleanData(table([['a'.repeat(MAX_CELL_CHARACTERS / 2)]]), ['replace'], { replace: { columns: [0], find: 'a', replacement: 'aa' } });
  assert.equal(boundary.data.rows[0]!.cells[0]!.length, MAX_CELL_CHARACTERS);
});

test('formula source metadata survives changes and duplicate removals without evaluation or mutation', () => {
  const data = table([['  3 ', 'first'], ['3', 'second']]);
  data.rows[0]!.formulas = { 0: { formula: 'SUM(A1:A2)', address: 'A3', savedValue: '  3 ', range: 'A3:A4' } };
  data.rows[1]!.formulas = { 0: { formula: '1+2', address: 'A4', savedValue: '3' } };
  const before = JSON.stringify(data);
  const result = cleanData(data, ['trim', 'duplicatesByKey'], { duplicatesByKey: { columns: [0] } });
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(result.data.rows[0]!.formulas, data.rows[0]!.formulas);
  assert.deepEqual(result.data.rows[0]!.cells, ['3', 'first']);
  assert.deepEqual(result.removed[0]!.formulas, data.rows[1]!.formulas);
  assert.equal(result.data.rows[0]!.formulas![0]!.savedValue, '  3 ');
});
