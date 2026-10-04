export const MAX_ROWS = 20000;
export const MAX_COLUMNS = 100;
export const RECIPES = [
  { id: 'trim', title: 'Trim extra spaces', description: 'Tidy the edges of every cell' },
  { id: 'sku', title: 'Standardize SKUs', description: 'Use consistent uppercase codes' },
  { id: 'category', title: 'Unify categories', description: 'Match casing across categories' },
  { id: 'price', title: 'Clean price formatting', description: 'Remove symbols and thousands commas' },
  { id: 'duplicates', title: 'Remove exact duplicates', description: 'Keep the first identical row' },
];
export function detectDelimiter(text) {
  let quoted = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
export function parseCSV(input, delimiter) {
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('This file is empty. Choose a CSV with a header row and at least one data row.');
  delimiter ||= detectDelimiter(text);
  if (![',', ';', '\t'].includes(delimiter)) throw new Error('Unsupported delimiter.');
  const records = [];
  let row = [], field = '', quoted = false, closed = false, recordTouched = false;
  function finishField() { row.push(field); field = ''; closed = false; if (row.length > MAX_COLUMNS) throw new Error(`Use at most ${MAX_COLUMNS} columns per file.`); }
  function finishRow() {
    finishField();
    if (recordTouched) records.push(row);
    row = []; recordTouched = false;
    if (records.length > MAX_ROWS + 1) throw new Error(`Use at most ${MAX_ROWS.toLocaleString()} rows per file.`);
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted || (c !== '\n' && c !== '\r')) recordTouched = true;
    if (c === '\0') throw new Error('This does not look like a UTF-8 text file. Export it as UTF-8 CSV first.');
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += c;
      continue;
    }
    if (c === delimiter) finishField();
    else if (c === '\n' || c === '\r') { finishRow(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else if (c === '"') { if (field || closed) throw new Error(`Unexpected quote in record ${records.length + 1}. Fields containing quotes must be fully quoted.`); quoted = true; }
    else if (closed) { if (!/[ \t]/.test(c)) throw new Error(`Unexpected text after a closing quote in record ${records.length + 1}.`); }
    else field += c;
  }
  if (quoted) throw new Error('An opening quote has no closing quote. Check the last quoted field in your CSV.');
  if (field || row.length || closed) finishRow();
  const headers = records.shift();
  if (!headers || !records.length) throw new Error('Add at least one data row below your column headers.');
  const keys = headers.map(x => x.trim().toLowerCase());
  if (keys.some(x => !x)) throw new Error('Every column needs a name. Fill in the blank column header and try again.');
  if (new Set(keys).size !== keys.length) throw new Error('Column names must be unique. Rename duplicate headers and try again.');
  const rows = records.map((cells, i) => {
    if (cells.length !== headers.length) throw new Error(`Data row ${i + 1} has ${cells.length} cells, but the header has ${headers.length}. Check its commas and quotes.`);
    return { id: i + 1, cells };
  });
  return { headers, rows, delimiter };
}
export function columnKinds(headers) {
  return headers.map(h => {
    const name = h.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (['sku', 'productcode', 'itemcode', 'productid', 'itemid', 'stockcode'].includes(name)) return 'sku';
    if (['category', 'categories', 'productcategory', 'department'].includes(name)) return 'category';
    if (['price', 'unitprice', 'retailprice', 'saleprice', 'cost', 'unitcost'].includes(name)) return 'price';
    if (['stock', 'quantity', 'qty', 'inventory', 'stockquantity', 'onhand', 'stockonhand'].includes(name)) return 'stock';
    return 'text';
  });
}
export function priceValue(value) {
  let s = value.trim();
  const currency = s.match(/^([$€£₱¥])\s*/)?.[1] || '';
  if (currency) s = s.replace(/^([$€£₱¥])\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  s = s.replaceAll(',', '');
  if (s.startsWith('.')) s = '0' + s;
  s = s.replace(/^0+(?=\d)/, '');
  if (!Number.isFinite(Number(s))) return null;
  return { value: s, currency };
}
export function categoryValue(value) {
  return value.trim().toLowerCase().replace(/(^|[\s/\-&])([\p{L}])/gu, (_, before, letter) => before + letter.toUpperCase());
}
function mixedCurrencyColumns(data) {
  const kinds = columnKinds(data.headers), mixed = new Set();
  kinds.forEach((kind, col) => { if (kind !== 'price') return;
    const currencies = new Set(data.rows.map(r => r.cells[col].trim().match(/^([$€£₱¥])/)?.[1]).filter(Boolean));
    if (currencies.size > 1) mixed.add(col);
  });
  return mixed;
}
export function analyze(data) {
  const kinds = columnKinds(data.headers), issues = new Map(), skuGroups = new Map(), exact = new Map(), mixed = mixedCurrencyColumns(data);
  const add = (id, col, code, message) => { if (!issues.has(id)) issues.set(id, []); issues.get(id).push({ col, code, message }); };
  for (const row of data.rows) {
    row.cells.forEach((v, c) => {
      const kind = kinds[c], label = data.headers[c];
      if (v !== v.trim()) add(row.id, c, 'space', `${label}: extra spaces at the edges.`);
      if (kind === 'sku') {
        if (!v.trim()) add(row.id, c, 'missing', `${label}: product code is missing.`);
        else {
          if (v.trim() !== v.trim().toUpperCase()) add(row.id, c, 'sku-case', `${label}: code uses lowercase letters.`);
          const key = c + ':' + v.trim().toUpperCase();
          if (!skuGroups.has(key)) skuGroups.set(key, []);
          skuGroups.get(key).push(row);
        }
      }
      if (kind === 'category' && v.trim() && v.trim() !== categoryValue(v)) add(row.id, c, 'category', `${label}: category casing is inconsistent.`);
      if (kind === 'price') {
        const parsed = priceValue(v);
        if (!v.trim()) add(row.id, c, 'missing', `${label}: price is missing. Enter it manually.`);
        else if (!parsed) add(row.id, c, 'number', `${label}: use a nonnegative number with a decimal point. Ambiguous values need review.`);
        else if (mixed.has(c) && parsed.currency) add(row.id, c, 'currency', `${label}: this column mixes currencies. Resolve currencies manually; no conversion is performed.`);
        else if (v.trim() !== parsed.value) add(row.id, c, 'price-format', `${label}: currency or number formatting can be cleaned.`);
      }
      if (kind === 'stock' && (!/^\d+$/.test(v.trim()) || !Number.isSafeInteger(Number(v.trim())))) add(row.id, c, 'stock', `${label}: enter a nonnegative whole number.`);
    });
    const key = JSON.stringify(row.cells);
    if (exact.has(key)) add(row.id, -1, 'duplicate', `This row is identical to row ${exact.get(key)}.`); else exact.set(key, row.id);
  }
  for (const [key, rows] of skuGroups) {
    if (rows.length < 2) continue;
    const distinct = new Set(rows.map(r => JSON.stringify(r.cells)));
    if (distinct.size > 1) for (const row of rows) add(row.id, Number(key.split(':')[0]), 'conflict', 'This SKU appears on different rows. Review those records; they will not be automatically merged.');
  }
  return { issues, total: data.rows.length, needsAttention: issues.size, ready: data.rows.length - issues.size, kinds };
}
export function cleanData(data, selected) {
  const enabled = new Set(selected), kinds = columnKinds(data.headers), mixed = mixedCurrencyColumns(data), seen = new Set();
  const changes = [], removed = [], rows = [];
  for (const row of data.rows) {
    const rowChanges = [];
    const cells = row.cells.map((original, col) => {
      let value = original;
      if (enabled.has('trim')) value = value.trim();
      if (enabled.has('sku') && kinds[col] === 'sku') value = value.trim().toUpperCase();
      if (enabled.has('category') && kinds[col] === 'category' && value.trim()) value = categoryValue(value);
      if (enabled.has('price') && kinds[col] === 'price' && !mixed.has(col)) value = priceValue(value)?.value ?? value;
      if (value !== original) rowChanges.push({ rowId: row.id, col, before: original, after: value });
      return value;
    });
    const key = JSON.stringify(cells);
    if (enabled.has('duplicates') && seen.has(key)) { removed.push(row); continue; }
    seen.add(key); changes.push(...rowChanges); rows.push({ ...row, cells });
  }
  return { data: { ...data, rows }, changes, removed };
}
export function isFormula(value) { return /^[\s\uFEFF]*[=+@-]/u.test(value) && !/^-\d+(?:\.\d+)?$/.test(value.trim()) || /^[\t\r\n]/.test(value); }
export function serializeCSV(data, safe = true) {
  let protectedCells = 0;
  const cell = value => {
    let text = String(value);
    if (safe && isFormula(text)) { text = "'" + text; protectedCells++; }
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  const text = [data.headers, ...data.rows.map(r => r.cells)].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  return { text, protectedCells };
}
export const SAMPLE_CSV = `SKU,Product name,Category,Price,Stock
RR-1001,Canvas Tote Bag,Accessories,12.50,24
rr-1002, Ceramic Mug ,HOME & LIVING,$8.00,42
RR-1003,Spiral Notebook,Stationery,4.50,60
RR-1004,Desk Planter,home & living,15.00,18
 RR-1005 ,Cotton Cap,Accessories,9.99,30
RR-1006,Wooden Tray,Home & Living,,12
RR-1007,Brass Keyring,accessories,6.50,45
RR-1008,Linen Pouch,Accessories,7.00,23
RR-1009,Glass Water Bottle,Home & Living,$18.50,16
RR-1010, Weekly Planner ,STATIONERY,11.00,28
RR-1011,Leather Cardholder,Accessories,22.00,15
RR-1012,Cork Coasters,Home & Living,8.50,35
RR-1013,Pencil Set,Stationery,3.00,ten
RR-1014,Reading Light,Home & Living,24.00,10
RR-1015,Enamel Pin,Accessories,5.50,50
RR-1008,Linen Pouch,Accessories,7.00,23
RR-1016,Sketch Pad,stationery,6.00,20
RR-1017,Travel Journal,Stationery,12.00,14
`;
