import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseCSV, cleanData, analyze, serializeCSV, priceValue, detectDelimiter, SAMPLE_CSV, PRESETS, MAX_ROWS } from '../src/index.js';
const all = PRESETS.find(preset => preset.profile === 'inventory')!.operations;
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
  assert.equal(priceValue('$1,234.50')?.value, '1234.50'); assert.equal(priceValue('0')?.value, '0'); assert.equal(priceValue('.50')?.value, '0.50');
  assert.equal(priceValue('12345678901234567890.1234')?.value, '12345678901234567890.1234');
});
test('different currencies remain unchanged and flagged', () => {
  const data = parseCSV('sku,price\nA,$10.00\nB,€9.00'); const result = cleanData(data, ['price']);
  assert.equal(result.changes.length, 0); assert.equal(analyze(result.data, 'inventory').needsAttention, 2);
});
test('missing prices and noninteger or negative stock remain visible', () => {
  const data = parseCSV('sku,price,stock\nA,,2.5\nB,0,0\nC,12abc,-1');
  const result = cleanData(data, all); assert.equal(analyze(result.data, 'inventory').needsAttention, 2); assert.equal(result.data.rows[0].cells[1], ''); assert.equal(result.data.rows[2].cells[2], '-1');
});
test('duplicate cleanup retains first exact row; conflicting SKUs are never merged', () => {
  const data = parseCSV('sku,price\n abc ,2.50\nABC,2.50\nABC,3.00');
  const result = cleanData(data, all); assert.equal(result.removed.length, 1); assert.deepEqual(result.data.rows.map(r => r.id), [1, 3]); assert.equal(analyze(result.data, 'inventory').needsAttention, 2);
});
test('duplicates compare unknown columns too', () => {
  const data = parseCSV('sku,price,notes\nA,1,red\nA,1,blue'); assert.equal(cleanData(data, all).removed.length, 0);
});
test('cleanup is immutable, stable and idempotent', () => {
  const original = parseCSV(SAMPLE_CSV), before = JSON.stringify(original), result = cleanData(original, all), again = cleanData(result.data, all);
  assert.equal(JSON.stringify(original), before); assert.equal(again.changes.length, 0); assert.equal(again.removed.length, 0);
  assert.equal(result.data.rows.length, 17); assert.equal(analyze(result.data, 'inventory').needsAttention, 2);
});
test('sample demonstrates cell repairs and exact duplicate removal', () => {
  const data = parseCSV(SAMPLE_CSV), result = cleanData(data, all); assert.equal(data.rows.length, 18); assert.ok(analyze(data, 'inventory').needsAttention > 2); assert.equal(result.removed.length, 1); assert.ok(result.changes.length >= 8);
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
  const data = parseCSV('sku\n""\nA\n'); assert.equal(data.rows.length, 2); assert.deepEqual(data.rows[0].cells, ['']); assert.equal(analyze(data, 'inventory').needsAttention, 1);
});
test('invalid prices still contribute to mixed-currency detection', () => {
  const data = parseCSV('sku,price\nA,$10.00\nB,€oops'); const result = cleanData(data, ['price']);
  assert.equal(result.changes.length, 0); assert.equal(result.data.rows[0].cells[1], '$10.00'); assert.equal(analyze(result.data, 'inventory').needsAttention, 2);
});
test('export keeps empty records in a one-column CSV', () => {
  const data = parseCSV('sku\n""\nA\n""');
  for (const safe of [false, true]) {
    const result = parseCSV(serializeCSV(data, safe).text);
    assert.deepEqual(result.rows, data.rows);
  }
});
test('column and UTF-8 bounds fail explicitly', () => {
  const headers = Array.from({ length: 101 }, (_, index) => `column${index}`).join(',');
  assert.throws(() => parseCSV(`${headers}\n${Array(101).fill('value').join(',')}`), /100 columns/);
  assert.throws(() => parseCSV('sku\nA\0B'), /UTF-8/);
});
test('removing duplicates reports only changes retained in the cleaned dataset', () => {
  const data = parseCSV('sku,price\nABC,2.50\n abc ,$2.50');
  const result = cleanData(data, all);
  assert.equal(result.changes.length, 0);
  assert.deepEqual(result.removed, [data.rows[1]]);
  assert.deepEqual(result.data.rows, [data.rows[0]]);
});


test('general review works on arbitrary contacts and students without assuming column semantics', () => {
  const contacts = parseCSV('Contact,Email,Notes\n Ana ,ana@example.com,\nBo,,call tomorrow');
  const contactReview = analyze(contacts);
  assert.deepEqual(contactReview.kinds, ['text', 'text', 'text']);
  assert.equal(contactReview.needsAttention, 2);
  assert.deepEqual(contactReview.issues.get(1)?.map(({ col, code }) => ({ col, code })), [
    { col: 0, code: 'space' }, { col: 2, code: 'missing' },
  ]);
  assert.deepEqual(contactReview.issues.get(2)?.map(({ col, code }) => ({ col, code })), [{ col: 1, code: 'missing' }]);
  assert.match(contactReview.issues.get(2)![0].message, /Review whether it is needed/);

  const students = parseCSV('Student ID,Date,Grade,Department\n00123,03/04/2026,01.20,computer science\n00456,2026-10-04,-1.50,arts');
  const studentReview = analyze(students);
  assert.deepEqual(studentReview.kinds, ['text', 'text', 'text', 'text']);
  assert.equal(studentReview.needsAttention, 0);
  assert.deepEqual(analyze(students, 'general'), studentReview);
});

test('general review flags empty and whitespace-only values in every column once as missing', () => {
  const data = parseCSV('Name,Price,Stock,SKU,Notes\n,  ,,,\nA,0,0,001,optional');
  const review = analyze(data);
  const missing = review.issues.get(1)!.filter(issue => issue.code === 'missing');
  assert.deepEqual(missing.map(issue => issue.col), [0, 1, 2, 3, 4]);
  assert.equal(review.issues.get(1)!.filter(issue => issue.code === 'space').length, 1);
  assert.equal(review.needsAttention, 1);
  assert.equal(review.ready, 1);
  assert.deepEqual(cleanData(data, ['trim']).data.rows[0].cells, ['', '', '', '', '']);
});

test('general cleanup preserves dates, numeric formatting, leading zeros, and inventory-like headers', () => {
  const data = parseCSV('SKU,Price,Stock,Category,Date,Identifier\n ab001 ,001.20,-2.5,home OFFICE,03/04/2026,00042\nab001,-5.50,2.5,home OFFICE,2026-10-04,00043');
  const original = JSON.stringify(data);
  const review = analyze(data);
  assert.deepEqual(review.kinds, Array(6).fill('text'));
  assert.deepEqual(review.issues.get(1)?.map(issue => issue.code), ['space']);
  assert.equal(review.issues.has(2), false);
  const result = cleanData(data, ['trim', 'duplicates']);
  assert.equal(JSON.stringify(data), original);
  assert.deepEqual(result.data.rows.map(row => row.cells), [
    ['ab001', '001.20', '-2.5', 'home OFFICE', '03/04/2026', '00042'],
    ['ab001', '-5.50', '2.5', 'home OFFICE', '2026-10-04', '00043'],
  ]);
  assert.equal(result.removed.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(analyze(result.data).needsAttention, 0);
  assert.ok(analyze(result.data, 'inventory').needsAttention > 0);
});

test('general duplicate review compares complete exact rows and never coerces values', () => {
  const data = parseCSV('ID,Date,Value\n001,03/04/2026,01.20\n001,03/04/2026,01.20\n1,03/04/2026,01.20\n001,2026-03-04,01.20\n001,03/04/2026,1.20\n 001 ,03/04/2026,01.20');
  const review = analyze(data);
  assert.deepEqual([...review.issues].filter(([, issues]) => issues.some(issue => issue.code === 'duplicate')).map(([id]) => id), [2]);
  const exactOnly = cleanData(data, ['duplicates']);
  assert.deepEqual(exactOnly.removed.map(row => row.id), [2]);
  assert.deepEqual(exactOnly.data.rows.map(row => row.id), [1, 3, 4, 5, 6]);
  assert.equal(exactOnly.changes.length, 0);
  const trimmed = cleanData(data, ['trim', 'duplicates']);
  assert.deepEqual(trimmed.removed.map(row => row.id), [2, 6]);
  assert.deepEqual(trimmed.data.rows.map(row => row.id), [1, 3, 4, 5]);
});
