import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, cleanData, analyze, serializeCSV, priceValue, detectDelimiter, SAMPLE_CSV, RECIPES, MAX_ROWS } from '../dist/data.js';
const all = RECIPES.map(r => r.id);
test('quoted separators, escaped quotes, multiline values and leading-zero IDs are lossless', () => {
  const data = parseCSV('sku,name,price,stock\r\n00123,"12"" mug,\nblue","₱1,299.50",02\r\n');
  assert.deepEqual(data.rows[0].cells, ['00123', '12" mug,\nblue', '₱1,299.50', '02']);
  assert.equal(data.rows.length, 1);
});
test('BOM, CRLF and trailing newline do not create phantom rows', () => {
  const data = parseCSV('\uFEFFsku,price\r\n001,0\r\n002,3.50\r\n');
  assert.equal(data.headers[0], 'sku'); assert.equal(data.rows.length, 2);
});
test('detect comma, semicolon and tab without counting quoted delimiters', () => {
  for (const d of [',', ';', '\t']) {
    const csv = `sku${d}"name,extra"${d}price\n01${d}Mug${d}2.50`;
    assert.equal(detectDelimiter(csv), d); assert.equal(parseCSV(csv).rows[0].cells.length, 3);
  }
});
test('malformed quotes and row lengths fail without dropping cells', () => {
  for (const csv of ['a,b\n"open,1', 'a,b\nx,y,z', 'a,b\nx', 'a,b\nx"y,z', 'a,b\n"x"bad,y']) assert.throws(() => parseCSV(csv));
});
test('empty, duplicated or blank headers are rejected', () => {
  for (const csv of ['', 'a,b\n', 'SKU,sku\n1,2', 'a,\n1,2']) assert.throws(() => parseCSV(csv));
});
test('blank single-cell lines skipped; actual empty multi-cell records preserved', () => {
  const data = parseCSV('a,b\n\n,\n1,2\n'); assert.equal(data.rows.length, 2); assert.deepEqual(data.rows[0].cells, ['', '']);
});
test('CSV round trip preserves all retained strings', () => {
  const data = parseCSV('sku,name,price\n001,"x,""y""\nz",01.20\n002,=1+2,0');
  const result = parseCSV(serializeCSV(data, false).text); assert.deepEqual(result.headers, data.headers); assert.deepEqual(result.rows, data.rows);
});
test('trim only changes cell edges and never internal whitespace or leading zero IDs', () => {
  const data = parseCSV('sku,name\n 00ab7 ,"  Large  mug\nblue  "');
  const result = cleanData(data, ['trim', 'sku']); assert.deepEqual(result.data.rows[0].cells, ['00AB7', 'Large  mug\nblue']);
  assert.equal(data.rows[0].cells[0], ' 00ab7 ');
});
test('full numeric validation avoids partial parsing and ambiguous decimal commas', () => {
  for (const s of ['12abc', 'Infinity', '12,50', '€1.234,50', '-1', 'N/A', '']) assert.equal(priceValue(s), null);
  assert.equal(priceValue('$1,234.50').value, '1234.50'); assert.equal(priceValue('0').value, '0'); assert.equal(priceValue('.50').value, '0.50');
  assert.equal(priceValue('12345678901234567890.1234').value, '12345678901234567890.1234');
});
test('different currencies remain unchanged and flagged', () => {
  const data = parseCSV('sku,price\nA,$10.00\nB,€9.00'); const result = cleanData(data, ['price']);
  assert.equal(result.changes.length, 0); assert.equal(analyze(result.data).needsAttention, 2);
});
test('missing prices and noninteger or negative stock remain visible', () => {
  const data = parseCSV('sku,price,stock\nA,,2.5\nB,0,0\nC,12abc,-1');
  const result = cleanData(data, all); assert.equal(analyze(result.data).needsAttention, 2); assert.equal(result.data.rows[0].cells[1], ''); assert.equal(result.data.rows[2].cells[2], '-1');
});
test('duplicate cleanup retains first exact row; conflicting SKUs are never merged', () => {
  const data = parseCSV('sku,price\n abc ,2.50\nABC,2.50\nABC,3.00');
  const result = cleanData(data, all); assert.equal(result.removed.length, 1); assert.deepEqual(result.data.rows.map(r => r.id), [1, 3]); assert.equal(analyze(result.data).needsAttention, 2);
});
test('duplicates compare unknown columns too', () => {
  const data = parseCSV('sku,price,notes\nA,1,red\nA,1,blue'); assert.equal(cleanData(data, all).removed.length, 0);
});
test('cleanup is immutable, stable and idempotent', () => {
  const original = parseCSV(SAMPLE_CSV), before = JSON.stringify(original), result = cleanData(original, all), again = cleanData(result.data, all);
  assert.equal(JSON.stringify(original), before); assert.equal(again.changes.length, 0); assert.equal(again.removed.length, 0);
  assert.equal(result.data.rows.length, 17); assert.equal(analyze(result.data).needsAttention, 2);
});
test('sample demonstrates cell repairs and exact duplicate removal', () => {
  const data = parseCSV(SAMPLE_CSV), result = cleanData(data, all); assert.equal(data.rows.length, 18); assert.ok(analyze(data).needsAttention > 2); assert.equal(result.removed.length, 1); assert.ok(result.changes.length >= 8);
});
test('spreadsheet-safe export protects formulas including headers and whitespace prefixes', () => {
  const data = { headers: ['=header', 'value'], rows: [{ id: 1, cells: [' @SUM(1,2)', '=1+2'] }, { id: 2, cells: ['-12', '\t+danger'] }] };
  const result = serializeCSV(data, true); assert.equal(result.protectedCells, 4);
  const parsed = parseCSV(result.text); assert.equal(parsed.headers[0], "'=header"); assert.equal(parsed.rows[0].cells[0], "' @SUM(1,2)"); assert.equal(parsed.rows[1].cells[0], '-12');
});
test('unknown columns are preserved and supported aliases are recognized', () => {
  const data = parseCSV('Product Code,Unit Price,Qty,custom\n00ab,$2.50,3, keep ');
  const result = cleanData(data, all); assert.deepEqual(result.data.rows[0].cells, ['00AB', '2.50', '3', 'keep']);
});
test('large imports are explicitly bounded', () => {
  assert.throws(() => parseCSV('sku\n' + Array.from({length:MAX_ROWS + 1}, (_,i)=>String(i)).join('\n')), /20,000/);
});
test('quoted empty records in a one-column file are retained', () => {
  const data = parseCSV('sku\n""\nA\n'); assert.equal(data.rows.length, 2); assert.deepEqual(data.rows[0].cells, ['']); assert.equal(analyze(data).needsAttention, 1);
});
