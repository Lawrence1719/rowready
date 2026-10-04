import { describe, expect, it } from 'vitest';
import { CFB, read, utils, write, type WorkBook, type WorkSheet } from 'xlsx';
import type { CsvDataset } from '@rowready/shared';
import { exportWorkbook, importWorksheet, inspectWorkbook } from './excel';

function workbookBytes(sheets: Record<string, WorkSheet>, configure?: (workbook: WorkBook) => void): ArrayBuffer {
  const workbook = utils.book_new();
  Object.entries(sheets).forEach(([name, sheet]) => utils.book_append_sheet(workbook, sheet, name));
  configure?.(workbook);
  return write(workbook, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
}

function tableBytes(rows: unknown[][]): ArrayBuffer {
  return workbookBytes({ Inventory: utils.aoa_to_sheet(rows) });
}

function replaceXml(buffer: ArrayBuffer, path: string, transform: (xml: string) => string): ArrayBuffer {
  const archive = CFB.read(new Uint8Array(buffer), { type: 'buffer' });
  const file = CFB.find(archive, `/${path}`);
  CFB.utils.cfb_add(archive, `/${path}`, new TextEncoder().encode(transform(new TextDecoder().decode(file.content))));
  const result: Uint8Array = CFB.write(archive, { type: 'buffer', fileType: 'zip' });
  return Uint8Array.from(result).buffer;
}

describe('Excel worksheet import', () => {
  it('lists worksheets in workbook order and distinguishes hidden and very hidden sheets', () => {
    const buffer = workbookBytes({ Inventory: utils.aoa_to_sheet([['SKU'], ['01']]), Hidden: {}, Private: {} }, (workbook) => {
      workbook.Workbook = { Sheets: [{ name: 'Inventory', Hidden: 0 }, { name: 'Hidden', Hidden: 1 }, { name: 'Private', Hidden: 2 }] };
    });
    expect(inspectWorkbook(buffer)).toEqual([
      { name: 'Inventory', hidden: false }, { name: 'Hidden', hidden: true }, { name: 'Private', hidden: true },
    ]);
    expect(() => importWorksheet(buffer, 'Hidden')).toThrow(/Unhide/);
    expect(() => importWorksheet(buffer, 'Private')).toThrow(/Unhide/);
  });

  it('imports only the selected table, tolerating empty leading rows, columns and gaps', () => {
    const inventory = utils.sheet_add_aoa({}, [['SKU', 'Product name', 'Price'], ['001', '  Green tea  ', '12.00'], [], ['002', 'Multiline\nname', '']], { origin: 'B4' });
    const ignored = utils.aoa_to_sheet([['Different'], ['elsewhere']]);
    const result = importWorksheet(workbookBytes({ Other: ignored, Inventory: inventory }), 'Inventory');
    expect(result.data).toEqual({
      headers: ['SKU', 'Product name', 'Price'], delimiter: ',',
      rows: [{ id: 1, cells: ['001', '  Green tea  ', '12.00'] }, { id: 2, cells: ['002', 'Multiline\nname', ''] }],
    });
    expect(result.notes.join(' ')).toContain('selected worksheet');
  });

  it('preserves formatted leading zeros, date text, decimals and booleans', () => {
    const sheet = utils.aoa_to_sheet([['SKU', 'Date', 'Price', 'Active'], [42, 45292, 2.5, true]]);
    sheet.A2.z = '000000';
    sheet.B2.z = 'yyyy-mm-dd';
    sheet.C2.z = '0.00';
    const result = importWorksheet(workbookBytes({ Inventory: sheet }), 'Inventory');
    expect(result.data.rows[0]?.cells).toEqual(['000042', '2024-01-01', '2.50', 'TRUE']);
    expect(result.notes.join(' ')).toContain('Numbers and dates');
  });

  it('preserves 1904 workbook date display without timezone conversion', () => {
    const sheet = utils.aoa_to_sheet([['Date'], [1]]);
    sheet.A2.z = 'yyyy-mm-dd';
    const buffer = workbookBytes({ Inventory: sheet }, (workbook) => { workbook.Workbook = { WBProps: { date1904: true } }; });
    expect(importWorksheet(buffer, 'Inventory').data.rows[0]?.cells).toEqual(['1904-01-02']);
  });

  it('imports saved numeric, zero, boolean, text, and blank formula results with source metadata', () => {
    const sheet = utils.aoa_to_sheet([['Amount', 'Zero', 'Active', 'Name', 'Blank'], [42, 0, false, 'Maya', '']]);
    sheet.A2 = { t: 'n', v: 42, f: 'SUM(20,22)', z: '000000' };
    sheet.B2.f = '1-1';
    sheet.C2.f = '1=2';
    sheet.D2.f = '"Maya"';
    sheet.E2.f = 'IF(A2=42,"","no")';
    const result = importWorksheet(workbookBytes({ Data: sheet }), 'Data');
    expect(result.data.rows[0]!.cells).toEqual(['000042', '0', 'FALSE', 'Maya', '']);
    expect(result.data.rows[0]!.formulas).toEqual({
      0: { formula: 'SUM(20,22)', address: 'A2', savedValue: '000042' },
      1: { formula: '1-1', address: 'B2', savedValue: '0' },
      2: { formula: '1=2', address: 'C2', savedValue: 'FALSE' },
      3: { formula: '"Maya"', address: 'D2', savedValue: 'Maya' },
      4: { formula: 'IF(A2=42,"","no")', address: 'E2', savedValue: '' },
    });
    expect(result.notes.join(' ')).toMatch(/5 formula cells.*saved results.*may be outdated.*does not calculate formulas.*values only/);
  });

  it('retains a row whose only value is a saved blank formula result and maps offset columns', () => {
    const sheet = utils.sheet_add_aoa({}, [['Result'], ['']], { origin: 'C4' });
    sheet.C5.f = 'IF(TRUE,"","no")';
    const result = importWorksheet(workbookBytes({ Data: sheet }), 'Data');
    expect(result.data.headers).toEqual(['Result']);
    expect(result.data.rows).toEqual([{ id: 1, cells: [''], formulas: { 0: { formula: 'IF(TRUE,"","no")', address: 'C5', savedValue: '' } } }]);
  });

  it('rejects a formula with no cached result instead of inventing zero', () => {
    const sheet = utils.aoa_to_sheet([['Result'], [2]]);
    sheet.A2 = { t: 'n', f: '1+1' };
    expect(() => importWorksheet(workbookBytes({ Data: sheet }), 'Data')).toThrow(/A2 has no saved formula result.*Recalculate and save/);
  });

  it.each(['<c r="A2"><f>1+1</f></c>', '<c r="A2" t="b"><f>1=1</f></c>', '<c r="A2" t="str"><f>""</f></c>'])('rejects a missing formula cache in source XML: %s', (cell) => {
    const bytes = replaceXml(tableBytes([['Result'], [2]]), 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="A2"[^>]*>[\s\S]*?<\/c>/, cell));
    expect(() => importWorksheet(bytes, 'Inventory')).toThrow(/A2 has no saved formula result/);
  });

  it('imports array results with the anchor expression and range', () => {
    const sheet = utils.aoa_to_sheet([['Result'], [2], [4]]);
    sheet.A2 = { t: 'n', v: 2, f: 'ROW(A2:A3)*2-2', F: 'A2:A3' };
    sheet.A3.F = 'A2:A3';
    const result = importWorksheet(workbookBytes({ Data: sheet }), 'Data');
    expect(result.data.rows.map((row) => row.formulas?.[0])).toEqual([
      { formula: 'ROW(A2:A3)*2-2', range: 'A2:A3', address: 'A2', savedValue: '2' },
      { formula: 'ROW(A2:A3)*2-2', range: 'A2:A3', address: 'A3', savedValue: '4' },
    ]);
  });

  it('rejects an array member without a saved result', () => {
    const sheet = utils.aoa_to_sheet([['Result'], [2], [4]]);
    sheet.A2 = { t: 'n', v: 2, f: 'ROW(A2:A3)*2-2', F: 'A2:A3' };
    const bytes = replaceXml(workbookBytes({ Data: sheet }), 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="A3"[^>]*>[\s\S]*?<\/c>/, '<c r="A3"/>'));
    expect(() => importWorksheet(bytes, 'Data')).toThrow(/A3 has no saved formula result/);
  });

  it('preserves resolved shared formula expressions, ranges, and each saved result', () => {
    const bytes = replaceXml(tableBytes([['Result', 'Input'], [4, 2], [8, 4]]), 'xl/worksheets/sheet1.xml', (xml) => xml
      .replace(/<c r="A2"[^>]*>[\s\S]*?<\/c>/, '<c r="A2"><f t="shared" si="0" ref="A2:A3">B2*2</f><v>4</v></c>')
      .replace(/<c r="A3"[^>]*>[\s\S]*?<\/c>/, '<c r="A3"><f t="shared" si="0"/><v>8</v></c>'));
    const result = importWorksheet(bytes, 'Inventory');
    expect(result.data.rows.map((row) => row.formulas?.[0])).toEqual([
      { formula: 'B2*2', range: 'A2:A3', address: 'A2', savedValue: '4' },
      { formula: 'B3*2', range: 'A2:A3', address: 'A3', savedValue: '8' },
    ]);
  });

  it('rejects a shared formula without its anchor expression', () => {
    const bytes = replaceXml(tableBytes([['Result'], [2]]), 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="A2"[^>]*>[\s\S]*?<\/c>/, '<c r="A2"><f t="shared" si="9"/><v>2</v></c>'));
    expect(() => importWorksheet(bytes, 'Inventory')).toThrow(/A2 has an unresolved formula/);
  });

  it('rejects formula-based headers with guidance to replace them with text', () => {
    const sheet = utils.aoa_to_sheet([['Result'], [2]]);
    sheet.A1.f = '"Result"';
    expect(() => importWorksheet(workbookBytes({ Data: sheet }), 'Data')).toThrow(/Column headers cannot contain formulas.*text values/);
  });

  it('rejects formula error results with recalculation guidance', () => {
    const sheet = utils.aoa_to_sheet([['Result'], [2]]);
    sheet.A2 = { t: 'e', v: 7, f: '1/0' };
    expect(() => importWorksheet(workbookBytes({ Data: sheet }), 'Data')).toThrow(/A2 has an Excel formula error.*recalculate.*save/);
  });

  it('does not reject a selected sheet because another sheet has a formula', () => {
    const formula = utils.aoa_to_sheet([['Stock'], [2]]);
    formula.A2.f = '1+1';
    expect(importWorksheet(workbookBytes({ Formula: formula, Inventory: utils.aoa_to_sheet([['SKU'], ['01']]) }), 'Inventory').data.rows).toHaveLength(1);
  });

  it('rejects Excel error cells', () => {
    const sheet = utils.aoa_to_sheet([['Stock'], [2]]);
    sheet.A2 = { t: 'e', v: 7 };
    expect(() => importWorksheet(workbookBytes({ Inventory: sheet }), 'Inventory')).toThrow(/A2 contains an Excel error/);
  });

  it('rejects merged cells, including merges outside the data table', () => {
    const sheet = utils.aoa_to_sheet([['SKU'], ['01']]);
    sheet['!merges'] = [utils.decode_range('B10:C10')];
    expect(() => importWorksheet(workbookBytes({ Inventory: sheet }), 'Inventory')).toThrow(/merged cells/);
  });

  it.each([
    { rows: [['SKU', ''], ['01', 'Tea']], message: /Every column needs a name/ },
    { rows: [['SKU', ' sku '], ['01', '02']], message: /unique/ },
    { rows: [['SKU']], message: /at least one data row/ },
    { rows: [], message: /at least one data row/ },
  ])('rejects invalid tables: $rows', ({ rows, message }) => {
    expect(() => importWorksheet(tableBytes(rows), 'Inventory')).toThrow(message);
  });

  it('rejects rows with content beyond the header columns', () => {
    expect(() => importWorksheet(tableBytes([['SKU'], ['01', 'unlabeled value']]), 'Inventory')).toThrow(/Every column needs a name/);
  });

  it('rejects more than 100 columns and 20,000 data rows', () => {
    expect(() => importWorksheet(tableBytes([Array.from({ length: 101 }, (_, index) => `Column ${index}`), Array(101).fill('x')]), 'Inventory')).toThrow(/100 columns/);
    expect(() => importWorksheet(tableBytes([['SKU'], ...Array.from({ length: 20_001 }, (_, index) => [String(index)])]), 'Inventory')).toThrow(/20,000 data rows/);
  });

  it('rejects oversized cell text before creating a workspace', () => {
    const buffer = replaceXml(tableBytes([['SKU'], ['REPLACE_ME']]), 'xl/worksheets/sheet1.xml', (xml) => xml.replace('REPLACE_ME', 'x'.repeat(100_001)));
    expect(() => importWorksheet(buffer, 'Inventory')).toThrow(/100,000 character limit/);
  });

  it('reports a missing selected worksheet', () => {
    expect(() => importWorksheet(tableBytes([['SKU'], ['01']]), 'Missing')).toThrow(/no longer available/);
  });
});

describe('Excel archive validation', () => {
  it('rejects CSV or HTML mislabeled as .xlsx, encrypted/legacy containers, and truncated ZIPs', () => {
    for (const bytes of [new TextEncoder().encode('SKU\n001'), new TextEncoder().encode('<table><tr><td>SKU</td></tr></table>'), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, ...Array(40).fill(0)])]) {
      expect(() => inspectWorkbook(bytes.buffer)).toThrow(/valid, unencrypted .xlsx/);
    }
    const buffer = tableBytes([['SKU'], ['01']]);
    expect(() => inspectWorkbook(buffer.slice(0, buffer.byteLength - 2))).toThrow(/valid, unencrypted .xlsx/);
  });

  it('rejects renamed macro-enabled and binary workbook formats', () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([['SKU'], ['01']]), 'Inventory');
    for (const bookType of ['xlsm', 'xlsb', 'ods'] as const) {
      expect(() => inspectWorkbook(write(workbook, { type: 'array', bookType }) as ArrayBuffer)).toThrow(/valid, unencrypted .xlsx/);
    }
  });

  it('rejects an oversized compressed file before trying to parse it', () => {
    expect(() => inspectWorkbook(new ArrayBuffer(5 * 1024 * 1024 + 1))).toThrow(/5 MB/);
  });

  it('rejects archives declaring more than 32 MB of expanded content before decompression', () => {
    const buffer = tableBytes([['SKU'], ['01']]);
    const view = new DataView(buffer);
    for (let offset = 0; offset < buffer.byteLength - 46; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      view.setUint32(offset + 24, 33 * 1024 * 1024, true);
      const local = view.getUint32(offset + 42, true);
      view.setUint32(local + 22, 33 * 1024 * 1024, true);
      break;
    }
    expect(() => inspectWorkbook(buffer)).toThrow(/32 MB limit/);
  });
});

describe('Excel export', () => {
  it('exports imported formula results as text values without executable formulas', () => {
    const sheet = utils.aoa_to_sheet([['Result', 'Blank'], [2, '']]);
    sheet.A2.f = '1+1';
    sheet.B2.f = '""';
    const imported = importWorksheet(workbookBytes({ Data: sheet }), 'Data');
    const exported = read(exportWorkbook(imported.data), { type: 'array', cellFormula: true });
    expect(exported.Sheets['Cleaned data']!.A2).toMatchObject({ t: 's', v: '2' });
    expect(exported.Sheets['Cleaned data']!.B2).toMatchObject({ t: 's', v: '' });
    expect(exported.Sheets['Cleaned data']!.A2.f).toBeUndefined();
    expect(exported.Sheets['Cleaned data']!.B2.f).toBeUndefined();
  });

  it('writes every value as text, preserving leading zeros and formula-like strings without apostrophes', () => {
    const data: CsvDataset = {
      delimiter: ',', headers: ['SKU', 'Product', 'Price', 'Note'],
      rows: [{ id: 5, cells: ['000012', '=HYPERLINK("https://example.test")', '12.00', '+SUM(A1:A2)'] }, { id: 8, cells: ['000013', '@text', '-5', ''] }],
    };
    const buffer = exportWorkbook(data);
    const workbook = read(buffer, { type: 'array', cellFormula: true });
    expect(workbook.SheetNames).toEqual(['Cleaned data']);
    const sheet = workbook.Sheets['Cleaned data']!;
    for (const row of [1, 2, 3]) for (const column of ['A', 'B', 'C', 'D']) {
      expect(sheet[`${column}${row}`].t).toBe('s');
      expect(sheet[`${column}${row}`].f).toBeUndefined();
    }
    expect(importWorksheet(buffer, 'Cleaned data').data.rows.map((row) => row.cells)).toEqual(data.rows.map((row) => row.cells));
    expect(importWorksheet(buffer, 'Cleaned data').data.headers).toEqual(data.headers);
  });

  it('explains the Excel cell size limit without truncating content', () => {
    expect(() => exportWorkbook({ headers: ['Note'], delimiter: ',', rows: [{ id: 1, cells: ['x'.repeat(32_768)] }] })).toThrow(/32,767 characters.*export CSV/);
  });
});
