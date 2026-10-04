import type {
  Analysis,
  AnalysisProfile,
  CellChange,
  CellIssue,
  CleanupResult,
  CleanupOptions,
  ColumnKind,
  CsvDataset,
  CsvRow,
  Delimiter,
  OperationId,
} from './types.js';

export const MAX_ROWS = 20_000;
export const MAX_COLUMNS = 100;
export const MAX_REPLACE_TEXT_LENGTH = 1_000;
export const MAX_CELL_CHARACTERS = 100_000;

export function detectDelimiter(text: string): Delimiter {
  let quoted = false;
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (character === '\n' || character === '\r')) {
      break;
    } else if (!quoted && (character === ',' || character === ';' || character === '\t')) {
      counts[character]++;
    }
  }
  let delimiter: Delimiter = ',';
  for (const candidate of [';', '\t'] as const) {
    if (counts[candidate] > counts[delimiter]) delimiter = candidate;
  }
  return delimiter;
}

export function parseCSV(input: string, delimiter?: Delimiter): CsvDataset {
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) {
    throw new Error('This file is empty. Choose a CSV with a header row and at least one data row.');
  }
  const separator = delimiter ?? detectDelimiter(text);
  if (separator !== ',' && separator !== ';' && separator !== '\t') {
    throw new Error('Unsupported delimiter.');
  }

  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  let recordTouched = false;

  function finishField(): void {
    row.push(field);
    field = '';
    closed = false;
    if (row.length > MAX_COLUMNS) {
      throw new Error(`Use at most ${MAX_COLUMNS} columns per file.`);
    }
  }

  function finishRow(): void {
    finishField();
    if (recordTouched) records.push(row);
    row = [];
    recordTouched = false;
    if (records.length > MAX_ROWS + 1) {
      throw new Error(`Use at most ${MAX_ROWS.toLocaleString()} rows per file.`);
    }
  }

  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (quoted || (character !== '\n' && character !== '\r')) recordTouched = true;
    if (character === '\0') {
      throw new Error('This does not look like a UTF-8 text file. Export it as UTF-8 CSV first.');
    }
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === separator) {
      finishField();
    } else if (character === '\n' || character === '\r') {
      finishRow();
      if (character === '\r' && text[i + 1] === '\n') i++;
    } else if (character === '"') {
      if (field || closed) {
        throw new Error(`Unexpected quote in record ${records.length + 1}. Fields containing quotes must be fully quoted.`);
      }
      quoted = true;
    } else if (closed) {
      if (!/[ \t]/.test(character)) {
        throw new Error(`Unexpected text after a closing quote in record ${records.length + 1}.`);
      }
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new Error('An opening quote has no closing quote. Check the last quoted field in your CSV.');
  }
  if (field || row.length || closed) finishRow();
  const headers = records.shift();
  if (!headers || !records.length) {
    throw new Error('Add at least one data row below your column headers.');
  }
  const keys = headers.map((header) => header.trim().toLowerCase());
  if (keys.some((key) => !key)) {
    throw new Error('Every column needs a name. Fill in the blank column header and try again.');
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error('Column names must be unique. Rename duplicate headers and try again.');
  }
  const rows = records.map((cells, index): CsvRow => {
    if (cells.length !== headers.length) {
      throw new Error(`Data row ${index + 1} has ${cells.length} cells, but the header has ${headers.length}. Check its commas and quotes.`);
    }
    return { id: index + 1, cells };
  });
  return { headers, rows, delimiter: separator };
}

export function columnKinds(headers: readonly string[]): ColumnKind[] {
  return headers.map((header) => {
    const name = header.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (['sku', 'productcode', 'itemcode', 'productid', 'itemid', 'stockcode'].includes(name)) return 'sku';
    if (['category', 'categories', 'productcategory', 'department'].includes(name)) return 'category';
    if (['price', 'unitprice', 'retailprice', 'saleprice', 'cost', 'unitcost'].includes(name)) return 'price';
    if (['stock', 'quantity', 'qty', 'inventory', 'stockquantity', 'onhand', 'stockonhand'].includes(name)) return 'stock';
    return 'text';
  });
}

export interface ParsedPrice {
  value: string;
  currency: string;
}

export function priceValue(value: string): ParsedPrice | null {
  let normalized = value.trim();
  const currency = normalized.match(/^([$€£₱¥])\s*/)?.[1] ?? '';
  if (currency) normalized = normalized.replace(/^([$€£₱¥])\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized) && !/^\.\d+$/.test(normalized)) {
    return null;
  }
  normalized = normalized.replaceAll(',', '');
  if (normalized.startsWith('.')) normalized = '0' + normalized;
  normalized = normalized.replace(/^0+(?=\d)/, '');
  if (!Number.isFinite(Number(normalized))) return null;
  return { value: normalized, currency };
}

export function categoryValue(value: string): string {
  return value.trim().toLowerCase().replace(
    /(^|[\s/\-&])([\p{L}])/gu,
    (_match: string, before: string, letter: string) => before + letter.toUpperCase(),
  );
}

function mixedCurrencyColumns(data: CsvDataset): Set<number> {
  const kinds = columnKinds(data.headers);
  const mixed = new Set<number>();
  kinds.forEach((kind, col) => {
    if (kind !== 'price') return;
    const currencies = new Set(
      data.rows.map((row) => row.cells[col]!.trim().match(/^([$€£₱¥])/)?.[1]).filter(Boolean),
    );
    if (currencies.size > 1) mixed.add(col);
  });
  return mixed;
}

export function analyze(data: CsvDataset, profile: AnalysisProfile = 'general'): Analysis {
  const kinds: ColumnKind[] = profile === 'inventory' ? columnKinds(data.headers) : data.headers.map(() => 'text');
  const issues = new Map<number, CellIssue[]>();
  const skuGroups = new Map<string, CsvRow[]>();
  const exact = new Map<string, number>();
  const mixed = profile === 'inventory' ? mixedCurrencyColumns(data) : new Set<number>();

  function add(id: number, col: number, code: string, message: string): void {
    const rowIssues = issues.get(id) ?? [];
    rowIssues.push({ col, code, message });
    issues.set(id, rowIssues);
  }

  for (const row of data.rows) {
    row.cells.forEach((value, col) => {
      const kind = kinds[col];
      const label = data.headers[col];
      if (value !== value.trim()) add(row.id, col, 'space', `${label}: extra spaces at the edges.`);
      if (profile === 'general' && !value.trim()) {
        add(row.id, col, 'missing', `${label}: value is empty. Review whether it is needed.`);
      }
      if (kind === 'sku') {
        if (!value.trim()) {
          add(row.id, col, 'missing', `${label}: product code is missing.`);
        } else {
          if (value.trim() !== value.trim().toUpperCase()) {
            add(row.id, col, 'sku-case', `${label}: code uses lowercase letters.`);
          }
          const key = col + ':' + value.trim().toUpperCase();
          const group = skuGroups.get(key) ?? [];
          group.push(row);
          skuGroups.set(key, group);
        }
      }
      if (kind === 'category' && value.trim() && value.trim() !== categoryValue(value)) {
        add(row.id, col, 'category', `${label}: category casing is inconsistent.`);
      }
      if (kind === 'price') {
        const parsed = priceValue(value);
        if (!value.trim()) {
          add(row.id, col, 'missing', `${label}: price is missing. Enter it manually.`);
        } else if (!parsed) {
          add(row.id, col, 'number', `${label}: use a nonnegative number with a decimal point. Ambiguous values need review.`);
        } else if (mixed.has(col) && parsed.currency) {
          add(row.id, col, 'currency', `${label}: this column mixes currencies. Resolve currencies manually; no conversion is performed.`);
        } else if (value.trim() !== parsed.value) {
          add(row.id, col, 'price-format', `${label}: currency or number formatting can be cleaned.`);
        }
      }
      if (kind === 'stock' && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value.trim())))) {
        add(row.id, col, 'stock', `${label}: enter a nonnegative whole number.`);
      }
    });
    const key = JSON.stringify(row.cells);
    if (exact.has(key)) {
      add(row.id, -1, 'duplicate', `This row is identical to row ${exact.get(key)}.`);
    } else {
      exact.set(key, row.id);
    }
  }
  for (const [key, rows] of skuGroups) {
    if (rows.length < 2) continue;
    const distinct = new Set(rows.map((row) => JSON.stringify(row.cells)));
    if (distinct.size > 1) {
      for (const row of rows) {
        add(row.id, Number(key.split(':')[0]), 'conflict', 'This SKU appears on different rows. Review those records; they will not be automatically merged.');
      }
    }
  }
  return {
    issues,
    total: data.rows.length,
    needsAttention: issues.size,
    ready: data.rows.length - issues.size,
    kinds,
  };
}

/** Validate local settings without sending column selections or replacement text to the API. */
export function validateCleanupOptions(data: CsvDataset, selected: Iterable<OperationId>, options?: CleanupOptions): void {
  const enabled = new Set(selected);
  for (const operation of ['whitespace', 'case', 'replace', 'duplicatesByKey'] as const) {
    if (!enabled.has(operation)) continue;
    const setting = options?.[operation];
    const label = { whitespace: 'Normalize repeated spaces', case: 'Change text casing', replace: 'Find and replace', duplicatesByKey: 'Duplicates by column' }[operation];
    if (!setting || !Array.isArray(setting.columns) || setting.columns.length === 0) {
      throw new Error(`${label}: choose at least one column.`);
    }
    const seen = new Set<number>();
    for (const column of setting.columns) {
      if (!Number.isInteger(column) || column < 0 || column >= data.headers.length) {
        throw new Error(`${label}: choose columns from the current file.`);
      }
      if (seen.has(column)) throw new Error(`${label}: each column can be selected only once.`);
      seen.add(column);
    }
  }
  if (enabled.has('case') && !['lower', 'upper', 'title'].includes(options!.case!.mode)) {
    throw new Error('Change text casing: choose lowercase, uppercase, or title case.');
  }
  if (enabled.has('replace')) {
    const { find, replacement } = options!.replace!;
    if (typeof find !== 'string' || find.length === 0 || find.length > MAX_REPLACE_TEXT_LENGTH) {
      throw new Error(`Find and replace: enter between 1 and ${MAX_REPLACE_TEXT_LENGTH.toLocaleString()} characters to find.`);
    }
    if (typeof replacement !== 'string' || replacement.length > MAX_REPLACE_TEXT_LENGTH) {
      throw new Error(`Find and replace: replacement must be text with at most ${MAX_REPLACE_TEXT_LENGTH.toLocaleString()} characters.`);
    }
  }
}

function textCase(value: string, mode: NonNullable<CleanupOptions['case']>['mode']): string {
  if (mode === 'upper') return value.toUpperCase();
  if (mode === 'lower') return value.toLowerCase();
  return value.toLowerCase().replace(
    /(^|[^\p{L}\p{N}'’])([\p{L}])/gu,
    (_match: string, prefix: string, letter: string) => prefix + letter.toUpperCase(),
  );
}

function replaceText(value: string, find: string, replacement: string, onOverflow: () => never): string {
  let matches = 0;
  for (let position = value.indexOf(find); position !== -1; position = value.indexOf(find, position + find.length)) {
    matches++;
  }
  // Check the expanded length before split/join can allocate an oversized replacement result.
  if (value.length + matches * (replacement.length - find.length) > MAX_CELL_CHARACTERS) onOverflow();
  return value.split(find).join(replacement);
}

/** Apply transforms in a fixed order, then retain the first row for each selected duplicate rule. */
export function cleanData(data: CsvDataset, selected: Iterable<OperationId>, options?: CleanupOptions): CleanupResult {
  const enabled = new Set(selected);
  validateCleanupOptions(data, enabled, options);
  const kinds = columnKinds(data.headers);
  const mixed = mixedCurrencyColumns(data);
  const seen = new Set<string>();
  const seenKeys = new Set<string>();
  const whitespaceColumns = new Set(enabled.has('whitespace') ? options!.whitespace!.columns : []);
  const caseColumns = new Set(enabled.has('case') ? options!.case!.columns : []);
  const replaceColumns = new Set(enabled.has('replace') ? options!.replace!.columns : []);
  const keyColumns = enabled.has('duplicatesByKey') ? options!.duplicatesByKey!.columns : [];
  const changes: CellChange[] = [];
  const removed: CsvRow[] = [];
  const rows: CsvRow[] = [];
  for (const row of data.rows) {
    const rowChanges: CellChange[] = [];
    const cells = row.cells.map((original, col) => {
      const overflow = (): never => {
        throw new Error(`Row ${row.id}, ${data.headers[col]}: cleanup would exceed the 100,000 character cell limit. Use a shorter replacement or fewer matches, or choose another casing option.`);
      };
      let value = original;
      if (enabled.has('trim')) value = value.trim();
      // Only repeated ASCII and nonbreaking spaces collapse; tabs and line breaks remain unchanged.
      if (whitespaceColumns.has(col)) value = value.replace(/[ \u00a0]{2,}/g, ' ');
      if (caseColumns.has(col)) {
        value = textCase(value, options!.case!.mode);
        if (value.length > MAX_CELL_CHARACTERS) overflow();
      }
      if (replaceColumns.has(col)) value = replaceText(value, options!.replace!.find, options!.replace!.replacement, overflow);
      if (enabled.has('sku') && kinds[col] === 'sku') value = value.trim().toUpperCase();
      if (enabled.has('category') && kinds[col] === 'category' && value.trim()) value = categoryValue(value);
      if (enabled.has('price') && kinds[col] === 'price' && !mixed.has(col)) value = priceValue(value)?.value ?? value;
      if (value !== original && value.length > MAX_CELL_CHARACTERS) overflow();
      if (value !== original) rowChanges.push({ rowId: row.id, col, before: original, after: value });
      return value;
    });
    const key = JSON.stringify(cells);
    const keyCells = keyColumns.map(col => cells[col]!);
    const columnKey = keyCells.length > 0 && keyCells.every(value => value.trim() !== '') ? JSON.stringify(keyCells) : null;
    if ((enabled.has('duplicates') && seen.has(key)) || (columnKey !== null && seenKeys.has(columnKey))) {
      removed.push(row);
      continue;
    }
    seen.add(key);
    if (columnKey !== null) seenKeys.add(columnKey);
    changes.push(...rowChanges);
    rows.push({ ...row, cells });
  }
  return { data: { ...data, rows }, changes, removed };
}

export function isFormula(value: string): boolean {
  return (/^[\s\uFEFF]*[=+@-]/u.test(value) && !/^-\d+(?:\.\d+)?$/.test(value.trim()))
    || /^[\t\r\n]/.test(value);
}

export interface SerializedCsv {
  text: string;
  protectedCells: number;
}

export function serializeCSV(data: Pick<CsvDataset, 'headers' | 'rows'>, safe = true): SerializedCsv {
  let protectedCells = 0;
  function cell(value: string): string {
    let text = String(value);
    if (safe && isFormula(text)) {
      text = "'" + text;
      protectedCells++;
    }
    // Quote empty cells so a one-column empty record survives re-import.
    return text === '' || /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }
  const text = [data.headers, ...data.rows.map((row) => row.cells)]
    .map((row) => row.map(cell).join(','))
    .join('\r\n') + '\r\n';
  return { text, protectedCells };
}
