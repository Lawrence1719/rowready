import { test, expect, type Page } from '@playwright/test';
import { SAMPLE_CSV } from '@rowready/shared';

async function importInventoryFixture(page: Page): Promise<void> {
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'test-inventory.csv', mimeType: 'text/csv', buffer: Buffer.from(SAMPLE_CSV),
  });
  await expect(page.getByRole('heading', { name: 'test-inventory.csv', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Cleaning preset' }).click();
  await page.getByRole('option', { name: 'Inventory cleanup', exact: true }).click();
}

test('column cleanup and key duplicates stay local, support removal review, and can be undone', async ({ page }) => {
  const errors: string[] = [];
  const payloads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.postData()) payloads.push(request.postData()!); });
  await page.goto('/');
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'column-cleanup.csv', mimeType: 'text/csv',
    buffer: Buffer.from('ID,Name,Notes\n001,aLICE   SMITH,aLICE   SMITH\n001,aLICE SECOND,Remove this duplicate\n002,BoB SMITH,BoB SMITH\n,Charlie,Keep blank key\n,Dana,Keep other blank key\n'),
  });
  await expect(page.getByRole('heading', { name: 'column-cleanup.csv', level: 1 })).toBeVisible();
  for (const [title, column] of [
    ['Normalize repeated spaces', 'Name'], ['Change text casing', 'Name'],
    ['Find and replace', 'Name'], ['Duplicates by column', 'ID'],
  ]) {
    await page.getByRole('checkbox', { name: new RegExp(`^${title}(?!:)`) }).check();
    await expect(page.getByRole('button', { name: 'Preview fixes', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: `${title}: ${column}`, exact: true }).check();
  }
  await page.getByRole('combobox', { name: 'Text case', exact: true }).click();
  await page.getByRole('option', { name: 'Uppercase', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find text', exact: true }).fill('SMITH');
  await page.getByRole('textbox', { name: 'Replacement text', exact: true }).fill('Jones');
  await page.getByRole('button', { name: 'Preview fixes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply fixes', exact: true })).toBeVisible();
  await expect(page.getByTestId('total-rows')).toHaveText('4');
  await expect(page.getByRole('button', { name: 'Edit row 1, Name: ALICE Jones', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit row 3, Name: BOB Jones', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit row 1, Notes: aLICE SMITH', exact: true })).toHaveAttribute('aria-label', 'Edit row 1, Notes: aLICE   SMITH');
  await expect(page.getByRole('button', { name: 'Edit row 4, Notes: Keep blank key', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit row 5, Notes: Keep other blank key', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review rows to remove', exact: true }).click();
  const removed = page.getByRole('dialog', { name: 'Rows to remove' });
  await expect(removed).toContainText('aLICE SECOND');
  await expect(removed).toContainText('Remove this duplicate');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Apply fixes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit row 1, Name: ALICE Jones', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('total-rows')).toHaveText('5');
  await expect(page.getByRole('button', { name: 'Edit row 1, Name: aLICE SMITH', exact: true })).toHaveAttribute('aria-label', 'Edit row 1, Name: aLICE   SMITH');
  await expect(page.getByRole('button', { name: 'Edit row 2, Name: aLICE SECOND', exact: true })).toBeVisible();
  expect(payloads).toHaveLength(1);
  expect(JSON.parse(payloads[0]!)).toEqual({
    version: 1, operations: expect.arrayContaining(['trim', 'duplicates', 'whitespace', 'case', 'replace', 'duplicatesByKey']),
  });
  expect(payloads.join('')).not.toContain('SMITH');
  expect(payloads.join('')).not.toContain('Jones');
  expect(payloads.join('')).not.toContain('column-cleanup');
  expect(errors).toEqual([]);
});

test('general cleanup preserves spreadsheet values and reviews missing data through the real worker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'project-records.csv', mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Date,Price,Stock,Category,Notes\nab-001,2026-10-04,0007,-3,eBay, Follow up \nab-001,2026-10-04,0007,-3,eBay, Follow up \nxy-002,04/10/2026,-12.50,0012,iOS,\n'),
  });
  await expect(page.getByRole('heading', { name: 'project-records.csv', level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Cleaning preset' })).toHaveText('General cleanup');
  await expect(page.getByRole('checkbox')).toHaveCount(6);
  await expect(page.getByRole('checkbox', { name: /Standardize SKUs/ })).toHaveCount(0);
  const validation = page.waitForRequest(request => request.url().endsWith('/api/recipes/validate'));
  await page.getByRole('button', { name: 'Preview fixes', exact: true }).click();
  expect((await validation).postDataJSON()).toEqual({ version: 1, operations: ['trim', 'duplicates'] });
  await page.getByRole('button', { name: 'Apply fixes', exact: true }).click();
  await expect(page.getByTestId('total-rows')).toHaveText('2');
  await expect(page.getByTestId('attention-rows')).toHaveText('1');
  for (const [row, column, value] of [
    [1, 'SKU', 'ab-001'], [1, 'Date', '2026-10-04'], [1, 'Price', '0007'],
    [1, 'Stock', '-3'], [1, 'Category', 'eBay'], [1, 'Notes', 'Follow up'],
    [3, 'Date', '04/10/2026'], [3, 'Price', '-12.50'], [3, 'Stock', '0012'], [3, 'Category', 'iOS'],
  ]) {
    await expect(page.getByRole('button', { name: `Edit row ${row}, ${column}: ${value}`, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: /Review 1 issues in row 3/ }).click();
  await expect(page.getByRole('region', { name: 'Row review' })).toContainText(/empty|missing/i);
  await expect(page.getByRole('region', { name: 'Row review' })).toContainText('Notes');
  expect(errors).toEqual([]);
});

test('empty workbench imports a local file and uses reversible cleanup through the API and real worker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CSV & Excel spreadsheet cleaner', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open a spreadsheet', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try the sample inventory' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export file', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview fixes', exact: true })).toBeDisabled();
  await importInventoryFixture(page);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export file', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Preview fixes', exact: true })).toBeEnabled();
  await expect(page.getByTestId('total-rows')).toHaveText('18');
  const validation = page.waitForRequest(request => request.url().endsWith('/api/recipes/validate'));
  await page.getByRole('button', { name: 'Preview fixes' }).click();
  const request = await validation;
  expect(request.postDataJSON()).toEqual({ version: 1, operations: ['trim', 'sku', 'category', 'price', 'duplicates'] });
  await expect(page.getByText('11 cells changed · 1 duplicate removed')).toBeVisible();
  await expect(page.getByTestId('total-rows')).toHaveText('17');
  await expect(page.getByTestId('attention-rows')).toHaveText('2');
  await page.getByRole('button', { name: 'Current', exact: true }).click();
  await expect(page.getByTestId('total-rows')).toHaveText('18');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Apply fixes' }).click();
  await expect(page.getByRole('button', { name: 'Export file', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('total-rows')).toHaveText('18');
  expect(errors).toEqual([]);
});

test('local import and protected export do not send file contents to the server', async ({ page }) => {
  const transmitted: string[] = [];
  page.on('request', request => { if (request.postData()) transmitted.push(request.postData()!); });
  await page.goto('/');
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'private-inventory.csv', mimeType: 'text/csv', buffer: Buffer.from('SKU,Product name,Price\n00001,=PRIVATE_SENTINEL,5.00\n'),
  });
  await expect(page.getByText('private-inventory.csv', { exact: true })).toBeVisible();
  await expect(page.getByTestId('total-rows')).toHaveText('1');
  await page.getByRole('button', { name: 'Export file', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('private-inventory-cleaned.csv');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text).toContain("00001,'=PRIVATE_SENTINEL,5.00");
  expect(transmitted.join('')).not.toContain('PRIVATE_SENTINEL');
  expect(transmitted.join('')).not.toContain('private-inventory');
});

test('invalid import preserves the current workspace', async ({ page }) => {
  await page.goto('/');
  await importInventoryFixture(page);
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('SKU,Price\n"unterminated,12') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('test-inventory.csv', { exact: true })).toBeVisible();
  await expect(page.getByTestId('total-rows')).toHaveText('18');
});

test('keyboard editing retains the current page and dialogs return focus to their opener', async ({ page }) => {
  const rows = Array.from({ length: 30 }, (_, index) => `RR-${1001 + index},Product ${index + 1},5.00,10`);
  await page.goto('/');
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'keyboard-inventory.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`SKU,Product name,Price,Stock\n${rows.join('\n')}\n`),
  });
  await expect(page.getByRole('heading', { name: 'keyboard-inventory.csv', level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Rows per page' })).toHaveText('25');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Showing 26–30 of 30 rows')).toBeVisible();

  const originalCell = page.getByRole('button', { name: 'Edit row 26, Product name: Product 26', exact: true });
  await originalCell.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Row 26, Product name', exact: true });
  await expect(editor).toBeFocused();
  await editor.fill('Updated product 26');
  await page.keyboard.press('Enter');
  const savedCell = page.getByRole('button', { name: 'Edit row 26, Product name: Updated product 26', exact: true });
  await expect(savedCell).toBeFocused();
  await expect(page.getByText('Showing 26–30 of 30 rows')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await editor.fill('Abandoned product');
  await page.keyboard.press('Escape');
  await expect(savedCell).toBeFocused();
  await expect(editor).not.toBeVisible();
  await expect(page.getByText('Showing 26–30 of 30 rows')).toBeVisible();

  const help = page.getByRole('button', { name: 'How to use RowReady' });
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'RowReady help' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(help).toBeFocused();

  const exportButton = page.getByRole('button', { name: 'Export file', exact: true });
  await exportButton.focus();
  await page.keyboard.press('Enter');
  const exportDialog = page.getByRole('dialog', { name: 'Export your data' });
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(exportDialog).not.toBeVisible();
  await expect(exportButton).toBeFocused();
  await expect(page.getByText('Showing 26–30 of 30 rows')).toBeVisible();
});

test('dropdowns support keyboard selection and Escape closes a menu before its export dialog', async ({ page }) => {
  await page.goto('/');
  await importInventoryFixture(page);
  const filter = page.getByRole('combobox', { name: 'Filter rows' });
  await filter.click();
  await expect(page.getByRole('option', { name: 'All rows', exact: true })).toBeFocused();
  await expect(page.getByRole('option', { name: 'Changed in preview', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Needs attention', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: 'Ready to go', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Ready to go', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  // Radix defers keyboard focus changes; settle Home before testing typeahead.
  await expect(page.getByRole('option', { name: 'All rows', exact: true })).toBeFocused();
  await page.keyboard.type('rea');
  await expect(page.getByRole('option', { name: 'Ready to go', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(filter).toHaveText('Ready to go');
  await expect(page.getByText('Showing 1–8 of 8 rows')).toBeVisible();
  await filter.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).not.toBeVisible();
  await expect(filter).toBeFocused();

  const exportButton = page.getByRole('button', { name: 'Export file', exact: true });
  await exportButton.click();
  const exportDialog = page.getByRole('dialog', { name: 'Export your data' });
  const format = page.getByRole('combobox', { name: 'Download format' });
  await format.click();
  await expect(page.getByRole('option', { name: 'CSV — spreadsheet data', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Excel (.xlsx) — spreadsheet data', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(format).toHaveText('Excel (.xlsx) — spreadsheet data');
  await expect(exportDialog.getByRole('button', { name: 'Download Excel' })).toBeVisible();
  await format.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).not.toBeVisible();
  await expect(exportDialog).toBeVisible();
  await expect(format).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(exportDialog).not.toBeVisible();
  await expect(exportButton).toBeFocused();
});

test('mobile workbench puts data first and keeps cleaning, export, and help reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await importInventoryFixture(page);
  const table = await page.getByRole('table').boundingBox();
  const cleaning = await page.getByRole('heading', { name: 'Cleaning steps', exact: true }).boundingBox();
  expect(table).not.toBeNull();
  expect(cleaning).not.toBeNull();
  expect(table!.y).toBeLessThan(cleaning!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'Preview fixes', exact: true }).click();
  await expect(page.getByText('11 cells changed · 1 duplicate removed')).toBeVisible();
  await page.getByRole('button', { name: 'Apply fixes', exact: true }).click();
  await expect(page.getByTestId('total-rows')).toHaveText('17');
  await page.getByRole('button', { name: 'Export file', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export your data' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download CSV', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('total-rows')).toHaveText('18');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'How to use RowReady' }).click();
  await expect(page.getByRole('dialog', { name: 'RowReady help' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
