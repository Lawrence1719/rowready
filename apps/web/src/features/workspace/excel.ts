import { read, utils, write, type CellObject, type WorkBook } from 'xlsx';
import { MAX_COLUMNS, MAX_ROWS, type CsvDataset, type FormulaCell } from '@rowready/shared';

export interface WorkbookSheet { name: string; hidden: boolean }

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_CELL_CHARACTERS = 100_000;
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const INVALID_WORKBOOK = 'Choose a valid, unencrypted .xlsx workbook. Other spreadsheet formats are not supported.';

/** Check ZIP metadata before the spreadsheet reader allocates expanded file contents. */
function checkArchive(buffer: ArrayBuffer): void {
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('Choose an Excel file smaller than 5 MB.');
  if (buffer.byteLength < 22) throw new Error(INVALID_WORKBOOK);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error(INVALID_WORKBOOK);

  let end = -1;
  for (let offset = buffer.byteLength - 22; offset >= Math.max(0, buffer.byteLength - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === buffer.byteLength) {
      end = offset;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error(INVALID_WORKBOOK);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (!count || count > 2048 || count !== view.getUint16(end + 8, true) || directoryStart + directorySize !== end) {
    throw new Error(INVALID_WORKBOOK);
  }

  let cursor = directoryStart;
  let expanded = 0;
  const names = new Set<string>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error(INVALID_WORKBOOK);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const expandedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || (method !== 0 && method !== 8) || localOffset + 30 > directoryStart) {
      throw new Error(INVALID_WORKBOOK);
    }
    const name = decoder.decode(new Uint8Array(buffer, cursor + 46, nameLength));
    if (!name || names.has(name) || name.includes('\\') || name.split('/').includes('..')) throw new Error(INVALID_WORKBOOK);
    names.add(name);
    if (view.getUint32(localOffset, true) !== 0x04034b50 || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method) {
      throw new Error(INVALID_WORKBOOK);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > directoryStart || localNameLength !== nameLength || decoder.decode(new Uint8Array(buffer, localOffset + 30, localNameLength)) !== name) {
      throw new Error(INVALID_WORKBOOK);
    }
    if (!(flags & 8) && (view.getUint32(localOffset + 18, true) !== compressedSize || view.getUint32(localOffset + 22, true) !== expandedSize)) {
      throw new Error(INVALID_WORKBOOK);
    }
    expanded += expandedSize;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('This workbook expands beyond the 32 MB limit. Remove unused sheets or export the table as CSV.');
    cursor = next;
  }
  if (cursor !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml') || [...names].some((name) => /(?:vbaProject\.bin|workbook\.bin)$/i.test(name))) {
    throw new Error(INVALID_WORKBOOK);
  }
}

function readWorkbook(buffer: ArrayBuffer, sheets: string[] = []): WorkBook {
  checkArchive(buffer);
  try {
    const workbook = read(buffer, {
      type: 'array', sheets, bookFiles: true, cellFormula: true, cellNF: true,
      cellText: true, cellDates: false, cellHTML: false, sheetStubs: true, xlfn: true, nodim: true, WTF: true,
    });
    // Checking the package content type also rejects macro-enabled files renamed to .xlsx.
    const files = (workbook as WorkBook & { files?: Record<string, { content?: Uint8Array | string }> }).files;
    const content = files?.['[Content_Types].xml']?.content;
    const types = typeof content === 'string' ? content : content ? new TextDecoder().decode(content) : '';
    const isXlsx = [...types.matchAll(/<(?:\w+:)?Override\b[^>]*>/g)].some(([tag]) =>
      /\bPartName\s*=\s*["']\/xl\/workbook\.xml["']/.test(tag) &&
      (tag.includes(`ContentType="${XLSX_CONTENT_TYPE}"`) || tag.includes(`ContentType='${XLSX_CONTENT_TYPE}'`)),
    );
    if (!isXlsx || !workbook.SheetNames.length) throw new Error(INVALID_WORKBOOK);
    return workbook;
  } catch {
    throw new Error(INVALID_WORKBOOK);
  }
}

function workbookSheets(workbook: WorkBook): WorkbookSheet[] {
  return workbook.SheetNames.map((name, index) => ({
    name,
    hidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
  }));
}

export function inspectWorkbook(buffer: ArrayBuffer): WorkbookSheet[] {
  return workbookSheets(readWorkbook(buffer));
}

function displayValue(cell: CellObject, address: string): string {
  if (cell.t === 'e') throw new Error(`Cell ${address} contains an Excel error. Fix the error before importing.`);
  if (cell.v === null || cell.v === undefined || cell.t === 'z') return '';
  const text = cell.t === 's' ? String(cell.v) : (cell.w ?? utils.format_cell(cell));
  if (text.length > MAX_CELL_CHARACTERS) throw new Error(`Cell ${address} exceeds the 100,000 character limit.`);
  return text;
}

function xmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const point = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[code] ?? entity;
  });
}

function xmlAttributes(value: string): Record<string, string> {
  return Object.fromEntries([...value.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((match) => [match[1]!, xmlText(match[3]!)]));
}

function workbookFile(workbook: WorkBook, path: string): string {
  const files = (workbook as WorkBook & { files?: Record<string, { content?: Uint8Array | string }> }).files;
  const content = files?.[path]?.content;
  return typeof content === 'string' ? content : content ? new TextDecoder().decode(content) : '';
}

interface FormulaSource { formula: string; range?: string }

/** Inspect cache presence in the source XML: SheetJS otherwise supplies zero for uncached formulas. */
function worksheetFormulas(workbook: WorkBook, sheetName: string): Map<string, FormulaSource> {
  const sheetInfo = workbook.Workbook?.Sheets?.find((sheet) => sheet.name === sheetName) as { id?: string } | undefined;
  const relation = [...workbookFile(workbook, 'xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)]
    .map(([tag]) => xmlAttributes(tag)).find((entry) => entry.Id === sheetInfo?.id);
  if (!relation?.Target || relation.TargetMode === 'External') throw new Error('This worksheet could not be read. Save a new .xlsx copy in Excel and try again.');
  const path: string[] = relation.Target.startsWith('/') ? [] : ['xl'];
  for (const segment of relation.Target.split('/')) {
    if (segment === '..') path.pop();
    else if (segment && segment !== '.') path.push(segment);
  }
  const source = workbookFile(workbook, path.join('/'));
  if (!source) throw new Error('This worksheet could not be read. Save a new .xlsx copy in Excel and try again.');
  const cells = new Map<string, { cache: boolean; formulaTag?: Record<string, string>; expression?: string }>();
  const arrays: { range: string; formula: string }[] = [];
  const shared = new Map<string, { range: string; formula: string }>();
  for (const cell of source.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c\s*>)/g)) {
    const attributes = xmlAttributes(cell[1]!);
    const address = attributes.r;
    if (!address || !/^[A-Z]+[1-9]\d*$/.test(address)) continue;
    const body = cell[2] ?? '';
    const cache = body.match(/<(?:\w+:)?v\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:\w+:)?v\s*>)/);
    const formula = body.match(/<(?:\w+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f\s*>)/);
    const formulaTag = formula ? xmlAttributes(formula[1]!) : undefined;
    const expression = formula ? xmlText(formula[2] ?? '') : undefined;
    const cachedValue = xmlText(cache?.[1] ?? '');
    const type = attributes.t ?? 'n';
    const validCache = Boolean(cache && (type === 'str' || cachedValue.trim() !== ''))
      && (type !== 'n' || Number.isFinite(Number(cachedValue)))
      && (type !== 'b' || /^(?:0|1|true|false)$/.test(cachedValue));
    cells.set(address, { cache: validCache, formulaTag, expression });
    if (formulaTag?.t === 'array' && formulaTag.ref && expression?.trim()) arrays.push({ range: formulaTag.ref, formula: expression });
    if (formulaTag?.t === 'shared' && formulaTag.si && formulaTag.ref && expression?.trim()) shared.set(formulaTag.si, { range: formulaTag.ref, formula: expression });
  }
  const formulas = new Map<string, FormulaSource>();
  const sheet = workbook.Sheets[sheetName]!;
  const unresolved = (address: string): Error => new Error(`Cell ${address} has an unresolved formula. Recalculate and save the workbook in Excel, or paste its results as values, then import again.`);
  const add = (address: string, formula: string, range?: string): void => {
    const sourceCell = cells.get(address);
    const cell = sheet[address] as CellObject | undefined;
    if (!sourceCell?.cache || !cell || cell.v === null || cell.v === undefined || cell.t === 'z') {
      throw new Error(`Cell ${address} has no saved formula result. Recalculate and save the workbook in Excel, then import again.`);
    }
    if (cell.t === 'e') throw new Error(`Cell ${address} has an Excel formula error. Fix it, recalculate, and save the workbook in Excel before importing.`);
    if (!formula.trim()) throw unresolved(address);
    if (formula.length > MAX_CELL_CHARACTERS) throw new Error(`Formula in cell ${address} exceeds the 100,000 character limit.`);
    formulas.set(address, { formula, ...(range ? { range } : {}) });
  };
  for (const [address, cell] of cells) {
    if (!cell.formulaTag) continue;
    if (cell.formulaTag.t === 'dataTable') throw unresolved(address);
    const anchor = cell.formulaTag.t === 'shared' ? shared.get(cell.formulaTag.si ?? '') : undefined;
    if (cell.formulaTag.t === 'shared' && !anchor) throw unresolved(address);
    const formula = cell.formulaTag.t === 'shared' ? sheet[address]?.f : cell.expression;
    if (typeof formula !== 'string' || !formula.trim()) throw unresolved(address);
    if (anchor) {
      if (!/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(anchor.range)) throw unresolved(address);
      const bounds = utils.decode_range(anchor.range);
      const point = utils.decode_cell(address);
      if (point.r < bounds.s.r || point.r > bounds.e.r || point.c < bounds.s.c || point.c > bounds.e.c) throw unresolved(address);
    }
    add(address, formula, anchor?.range ?? cell.formulaTag.ref);
  }
  for (const { range, formula } of arrays) {
    if (!/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(range)) throw new Error('An array formula has an invalid range. Recalculate and save the workbook in Excel before importing.');
    const bounds = utils.decode_range(range);
    if (bounds.e.c < bounds.s.c || bounds.e.r < bounds.s.r || bounds.e.c - bounds.s.c + 1 > MAX_COLUMNS || bounds.e.r - bounds.s.r + 1 > MAX_ROWS) {
      throw new Error('An array formula exceeds the table limits. Use at most 100 columns and 20,000 data rows.');
    }
    for (let row = bounds.s.r; row <= bounds.e.r; row++) {
      for (let col = bounds.s.c; col <= bounds.e.c; col++) add(utils.encode_cell({ r: row, c: col }), formula, range);
    }
  }
  // Never silently import a formula whose XML entry could not be resolved above.
  for (const [address, cell] of Object.entries(sheet)) {
    if ((cell?.f !== undefined || cell?.F !== undefined) && !formulas.has(address)) throw unresolved(address);
  }
  return formulas;
}

export function importWorksheet(buffer: ArrayBuffer, sheetName: string): { data: CsvDataset; notes: string[] } {
  const workbook = readWorkbook(buffer, [sheetName]);
  const selected = workbookSheets(workbook).find((sheet) => sheet.name === sheetName);
  if (!selected) throw new Error('That worksheet is no longer available. Choose another worksheet.');
  if (selected.hidden) throw new Error('Unhide this worksheet in Excel before importing it.');
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('This worksheet could not be read. Choose a worksheet containing a table.');
  if (sheet['!merges']?.length) throw new Error('This worksheet contains merged cells. Unmerge them and use a single header row before importing.');
  const formulas = worksheetFormulas(workbook, sheetName);

  const table = new Map<number, Map<number, string>>();
  const formulaRows = new Map<number, Map<number, FormulaCell>>();
  let firstColumn = Infinity;
  let lastColumn = -1;
  let formattedCells = 0;
  for (const [address, cell] of Object.entries(sheet)) {
    if (!/^[A-Z]+[1-9]\d*$/.test(address)) continue;
    const value = displayValue(cell as CellObject, address);
    const formula = formulas.get(address);
    if (!value && !formula) continue;
    const { r, c } = utils.decode_cell(address);
    firstColumn = Math.min(firstColumn, c);
    lastColumn = Math.max(lastColumn, c);
    if (lastColumn - firstColumn + 1 > MAX_COLUMNS) throw new Error(`Use at most ${MAX_COLUMNS} columns per worksheet.`);
    if (!table.has(r)) table.set(r, new Map());
    table.get(r)!.set(c, value);
    if (formula) {
      if (!formulaRows.has(r)) formulaRows.set(r, new Map());
      formulaRows.get(r)!.set(c, { ...formula, address, savedValue: value });
    }
    if (table.size > MAX_ROWS + 1) throw new Error(`Use at most ${MAX_ROWS.toLocaleString()} data rows per worksheet.`);
    if (cell.t !== 's') formattedCells++;
  }
  const rowNumbers = [...table.keys()].sort((a, b) => a - b);
  if (rowNumbers.length < 2) throw new Error('Add a header row and at least one data row to this worksheet.');
  if (formulaRows.has(rowNumbers[0]!)) throw new Error('Column headers cannot contain formulas. Replace the header formulas with text values in Excel before importing.');
  const valuesAt = (row: number): string[] => Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => table.get(row)?.get(firstColumn + index) ?? '');
  const headers = valuesAt(rowNumbers[0]!);
  const keys = headers.map((header) => header.trim().toLowerCase());
  if (keys.some((key) => !key)) throw new Error('Every column needs a name. Fill in the blank column header and try again.');
  if (new Set(keys).size !== keys.length) throw new Error('Column names must be unique. Rename duplicate headers and try again.');
  const data: CsvDataset = {
    headers,
    rows: rowNumbers.slice(1).map((row, index) => ({
      id: index + 1, cells: valuesAt(row),
      ...(formulaRows.has(row) ? { formulas: Object.fromEntries([...formulaRows.get(row)!].map(([column, formula]) => [column - firstColumn, formula])) } : {}),
    })),
    delimiter: ',',
  };
  const notes = ['Empty worksheet rows are skipped. Row IDs refer to the imported table, not Excel row numbers.', 'Only the selected worksheet is imported. Excel exports contain a new table of text values; workbook styling and other worksheets are not retained.'];
  if (formattedCells) notes.push('Numbers and dates were imported as displayed text, preserving number formats such as leading zeros.');
  if (formulas.size) notes.push(`${formulas.size.toLocaleString()} formula ${formulas.size === 1 ? 'cell was' : 'cells were'} imported using saved results. Results may be outdated; RowReady does not calculate formulas. Original formulas are available for inspection, and exports contain values only.`);
  return { data, notes };
}

export function exportWorkbook(data: CsvDataset): ArrayBuffer {
  const rows = [data.headers, ...data.rows.map((row) => row.cells)];
  if (data.headers.length > MAX_COLUMNS || data.rows.length > MAX_ROWS) throw new Error('This table is too large to export as Excel.');
  const sheet: Record<string, CellObject | string> = {};
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value.length > 32_767) throw new Error('Excel cells support at most 32,767 characters. Shorten the long cell or export CSV instead.');
      sheet[utils.encode_cell({ r, c })] = { t: 's', v: value };
    });
  });
  sheet['!ref'] = utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: data.headers.length - 1 } });
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, 'Cleaned data');
  return write(workbook, { bookType: 'xlsx', type: 'array', compression: true }) as ArrayBuffer;
}
