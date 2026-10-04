import { test, expect, type Download, type Page } from '@playwright/test';
import { SAMPLE_CSV } from '@rowready/shared';
import * as XLSX from 'xlsx';
import { PDFDocument } from 'pdf-lib';

async function importInventoryFixture(page: Page): Promise<void> {
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'test-inventory.csv', mimeType: 'text/csv', buffer: Buffer.from(SAMPLE_CSV),
  });
  await expect(page.getByRole('heading', { name: 'test-inventory.csv', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Cleaning preset' }).click();
  await page.getByRole('option', { name: 'Inventory cleanup', exact: true }).click();
}

async function bytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function workbookFixture(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Instructions'], ['Choose Warehouse for the inventory']]), 'Read me');
  const inventory = XLSX.utils.aoa_to_sheet([
    ['SKU', 'Product name', 'Category', 'Price', 'Stock'],
    ['00001', '=PRIVATE_EXCEL_SENTINEL', 'accessories', '$5.00', '10'],
    ['00002', ' Local mug ', 'HOME', '8.00', 'ten'],
  ]);
  XLSX.utils.book_append_sheet(workbook, inventory, 'Warehouse');
  const formulas = XLSX.utils.aoa_to_sheet([['SKU', 'Price'], ['001', 10]]);
  formulas['B2'] = { t: 'n', f: '5+5', v: 10 };
  XLSX.utils.book_append_sheet(workbook, formulas, 'Formulas');
  const missingCache = XLSX.utils.aoa_to_sheet([['SKU', 'Price'], ['001', 10]]);
  missingCache['B2'] = { t: 'n', f: '5+5' };
  XLSX.utils.book_append_sheet(workbook, missingCache, 'Missing cache');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('Excel chooses one worksheet and exports literal text without sending file contents', async ({ page }) => {
  const payloads: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (request.postData()) payloads.push(request.postData()!); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({ name: 'private-book.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbookFixture() });
  await expect(page.getByRole('dialog', { name: 'Choose a worksheet' })).toBeVisible();
  await expect(page.getByTestId('total-rows')).toHaveText('0');
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Worksheet', exact: true }).click();
  await page.getByRole('option', { name: 'Warehouse', exact: true }).click();
  await page.getByRole('button', { name: 'Import worksheet', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByTestId('total-rows')).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Edit row 1, SKU: 00001' })).toBeVisible();
  await page.getByRole('button', { name: 'Preview fixes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply fixes' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply fixes' }).click();
  await page.getByRole('button', { name: 'Export file' }).click();
  await expect(page.getByRole('combobox', { name: 'Download format' })).toHaveText('Excel (.xlsx) — spreadsheet data');
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Excel' }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('private-book-Warehouse-cleaned.xlsx');
  const result = XLSX.read(await bytes(download), { type: 'buffer' });
  expect(result.SheetNames).toEqual(['Cleaned data']);
  const sheet = result.Sheets[result.SheetNames[0]!]!;
  expect(sheet['A2']).toMatchObject({ t: 's', v: '00001' });
  expect(sheet['B2']).toMatchObject({ t: 's', v: '=PRIVATE_EXCEL_SENTINEL' });
  expect(sheet['B2'].f).toBeUndefined();
  expect(sheet['B3'].v).toBe('Local mug');
  expect(payloads.join('')).not.toContain('PRIVATE_EXCEL_SENTINEL');
  expect(payloads.join('')).not.toContain('private-book');
  expect(payloads.join('')).not.toContain('Warehouse');
  expect(errors).toEqual([]);
});

test('a formula without a cached result preserves data and allows another worksheet choice', async ({ page }) => {
  await page.goto('/');
  await importInventoryFixture(page);
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({ name: 'book.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbookFixture() });
  await page.getByRole('combobox', { name: 'Worksheet', exact: true }).click();
  await page.getByRole('option', { name: 'Missing cache', exact: true }).click();
  await page.getByRole('button', { name: 'Import worksheet', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/B2.*recalculat/i);
  await expect(page.getByTestId('total-rows')).toHaveText('18');
  await page.getByRole('combobox', { name: 'Worksheet', exact: true }).click();
  await page.getByRole('option', { name: 'Warehouse', exact: true }).click();
  await page.getByRole('button', { name: 'Import worksheet', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByTestId('total-rows')).toHaveText('2');
});

test('cached Excel formulas can be inspected and edited while exports contain only literal values', async ({ page }) => {
  const errors: string[] = [];
  const payloads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.postData()) payloads.push(request.postData()!); });
  await page.goto('/');
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'formula-values.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbookFixture(),
  });
  await page.getByRole('combobox', { name: 'Worksheet', exact: true }).click();
  await page.getByRole('option', { name: 'Formulas', exact: true }).click();
  await page.getByRole('button', { name: 'Import worksheet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'formula-values.xlsx', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit row 1, Price: 10', exact: true })).toBeVisible();
  const inspect = page.getByRole('button', { name: 'Inspect formula in row 1, Price', exact: true });
  await inspect.click();
  let dialog = page.getByRole('dialog', { name: 'Formula details' });
  await expect(dialog).toContainText('B2');
  await expect(dialog).toContainText('=5+5');
  await expect(dialog).toContainText(/not.*recalculat|no recalculation/i);
  await page.keyboard.press('Escape');
  await expect(inspect).toBeFocused();
  await page.getByRole('button', { name: 'Edit row 1, Price: 10', exact: true }).click();
  await page.getByRole('textbox', { name: 'Row 1, Price', exact: true }).fill('12');
  await page.keyboard.press('Enter');
  await inspect.click();
  dialog = page.getByRole('dialog', { name: 'Formula details' });
  await expect(dialog.getByText('10', { exact: true })).toBeVisible();
  await expect(dialog.getByText('12', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('=5+5');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export file', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export your data' })).toContainText(/formulas are not preserved or recalculated/i);
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Excel', exact: true }).click();
  const download = await pendingDownload;
  const result = XLSX.read(await bytes(download), { type: 'buffer', cellFormula: true });
  const values = result.Sheets['Cleaned data']!;
  expect(values.A2).toMatchObject({ t: 's', v: '001' });
  expect(values.B2).toMatchObject({ t: 's', v: '12' });
  expect(values.B2.f).toBeUndefined();
  expect(payloads).toEqual([]);
  expect(errors).toEqual([]);
});

test('PDF report downloads from the real worker with locally bundled fonts', async ({ page }) => {
  const errors: string[] = [];
  const payloads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.postData()) payloads.push(request.postData()!); });
  await page.goto('/');
  await importInventoryFixture(page);
  await page.getByRole('button', { name: 'Preview fixes', exact: true }).click();
  await page.getByRole('button', { name: 'Apply fixes', exact: true }).click();
  await page.getByRole('button', { name: 'Export file' }).click();
  await page.getByRole('combobox', { name: 'Download format' }).click();
  await page.getByRole('option', { name: 'PDF — cleanup report', exact: true }).click();
  await expect(page.getByText(/shareable summary/)).toBeVisible();
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('test-inventory-cleanup-report.pdf');
  const result = await PDFDocument.load(await bytes(download));
  expect(result.getTitle()).toBe('RowReady cleanup report — test-inventory.csv');
  expect(result.getPageCount()).toBeGreaterThanOrEqual(1);
  expect(result.getPageCount()).toBeLessThanOrEqual(3);
  expect(payloads).toHaveLength(1);
  expect(JSON.parse(payloads[0]!)).toEqual({ version: 1, operations: ['trim', 'sku', 'category', 'price', 'duplicates'] });
  expect(errors).toEqual([]);
});
