import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { read, utils, write, type WorkSheet } from 'xlsx';
import { parseCSV, SAMPLE_CSV } from '@rowready/shared';
import type { WorkerRequest } from '@/features/workspace/worker-client';
import { App } from './App';

const { workerRequests, workerGates } = vi.hoisted(() => ({
  workerRequests: [] as WorkerRequest[],
  workerGates: new Map<WorkerRequest['type'], Promise<void>>(),
}));

// Keep the UI's asynchronous worker boundary, exercising real CSV and Excel processing.
vi.mock('@/features/workspace/worker-client', async () => {
  const { cleanData, parseCSV, serializeCSV } = await import('@rowready/shared');
  const { inspectWorkbook, importWorksheet, exportWorkbook } = await import('@/features/workspace/excel');
  return {
    runWorker: vi.fn(async (request: WorkerRequest) => {
      workerRequests.push(request);
      const gate = workerGates.get(request.type);
      if (gate) { workerGates.delete(request.type); await gate; }
      switch (request.type) {
        case 'parse': return parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(request.buffer));
        case 'inspect-xlsx': return inspectWorkbook(request.buffer);
        case 'parse-xlsx': return importWorksheet(request.buffer, request.sheetName);
        case 'clean': return cleanData(request.data, request.operations, request.options);
        case 'export': return serializeCSV(request.data, request.safe).text;
        case 'export-xlsx': return exportWorkbook(request.data);
        // PDF rendering has its own unit/browser coverage; these tests verify the report input.
        case 'export-pdf': return new TextEncoder().encode('%PDF-1.7\nmock-report\n%%EOF').buffer;
        default: {
          const exhaustive: never = request;
          throw new Error(`Unexpected worker request: ${String(exhaustive)}`);
        }
      }
    }),
  };
});

vi.mock('@/lib/api', async importOriginal => {
  const api = await importOriginal<typeof import('@/lib/api')>();
  const { validateRecipeConfiguration } = await import('@rowready/shared');
  return {
    ...api,
    getCatalog: vi.fn(async () => api.LOCAL_CATALOG),
    validateRecipe: vi.fn(async (recipe: unknown) => { validateRecipeConfiguration(recipe); }),
  };
});

beforeEach(() => { vi.clearAllMocks(); workerRequests.length = 0; workerGates.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

function deferWorker(type: WorkerRequest['type']) {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
  workerGates.set(type, promise);
  return { resolve, reject };
}

function expectBusyWorkbench(label: string) {
  const workbench = document.querySelector<HTMLElement>('.workbench');
  expect(workbench).toHaveAttribute('inert');
  expect(workbench).toHaveAttribute('aria-busy', 'true');
  const announcement = screen.getAllByRole('status').find(status => !status.closest('[inert]') && status.textContent?.includes(label));
  expect(announcement).toBeInTheDocument();
  return workbench!;
}

async function openWorkspace(csv?: string) {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'Open a spreadsheet' });
  if (csv !== undefined) {
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([csv], 'inventory.csv', { type: 'text/csv' }));
    await screen.findByRole('heading', { name: 'inventory.csv' });
  }
  return user;
}

async function chooseOption(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

async function openInventoryWorkspace() {
  const user = await openWorkspace(SAMPLE_CSV);
  await chooseOption(user, 'Cleaning preset', 'Inventory cleanup');
  return user;
}

async function editFirstProduct(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(screen.getByRole('button', { name: 'Edit row 1, Product name: Canvas Tote Bag' }));
  await user.clear(screen.getByRole('textbox', { name: 'Row 1, Product name' }));
  await user.type(screen.getByRole('textbox', { name: 'Row 1, Product name' }), value);
  await user.keyboard('{Enter}');
}

function workbookFile(sheets: Record<string, WorkSheet>, filename = 'inventory.xlsx') {
  const workbook = utils.book_new();
  Object.entries(sheets).forEach(([name, sheet]) => utils.book_append_sheet(workbook, sheet, name));
  const buffer = write(workbook, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
  return new File([buffer], filename, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function captureDownloads() {
  const blobs: Blob[] = [];
  const downloads: { href: string; filename: string }[] = [];
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return `blob:rowready-${blobs.length}`; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, filename: this.download });
  });
  return { blobs, downloads };
}

describe('RowReady workspace', () => {
  it('notifies a changed cell once and stays quiet for unchanged or cancelled edits', async () => {
    const user = await openWorkspace('Name\nAlice');
    await user.click(within(await screen.findByTestId('notification-toast')).getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Edit row 1, Name: Alice' }));
    await user.clear(screen.getByRole('textbox', { name: 'Row 1, Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Row 1, Name' }), 'Bob');
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('notification-toast')).toHaveTextContent('Name updated in row 1.');
    expect(screen.getAllByTestId('notification-toast')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Bob' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Edit row 1, Name: Bob' }));
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit row 1, Name: Bob' }));
    await user.clear(screen.getByRole('textbox', { name: 'Row 1, Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Row 1, Name' }), 'Cancelled');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Bob' })).toBeVisible();
    expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument();
  });

  it('confirms an explicit preview discard while preserving the applied data', async () => {
    const user = await openWorkspace('Name\n Alice ');
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await screen.findByRole('button', { name: 'Apply fixes' });
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByTestId('notification-toast')).toHaveTextContent('Preview discarded. Your data is unchanged.');
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Alice' })).toHaveAttribute('aria-label', 'Edit row 1, Name:  Alice ');
    expect(screen.queryByRole('button', { name: 'Apply fixes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('shows an import error notification while keeping the inline error after dismissal', async () => {
    const user = await openWorkspace('Name\nAlice');
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File(['Name,Code\nAlice,001,extra'], 'broken.csv', { type: 'text/csv' }));
    const error = 'Data row 1 has 3 cells, but the header has 2.';
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(await screen.findByTestId('notification-toast')).toHaveTextContent(error);
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(error);
    expect(screen.getByRole('heading', { name: 'inventory.csv' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Alice' })).toBeVisible();
  });

  it('configures column-specific text cleanup, previews selected cells, and supports apply and undo', async () => {
    const user = await openWorkspace('ID,Name,Notes\n001,aLICE   SMITH,aLICE   SMITH\n002,BoB SMITH,BoB SMITH');
    for (const title of ['Normalize repeated spaces', 'Change text casing', 'Find and replace']) {
      await user.click(screen.getByRole('checkbox', { name: new RegExp(`^${title}(?!:)`) }));
      expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeDisabled();
      await user.click(screen.getByRole('checkbox', { name: `${title}: Name` }));
    }
    expect(screen.getByRole('combobox', { name: 'Text case' })).toHaveTextContent('Lowercase');
    await chooseOption(user, 'Text case', 'Uppercase');
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Find text' }), 'SMITH');
    await user.type(screen.getByRole('textbox', { name: 'Replacement text' }), 'Jones');
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await screen.findByRole('button', { name: 'Apply fixes' });
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: ALICE Jones' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 2, Name: BOB Jones' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 1, Notes: aLICE SMITH' })).toHaveAttribute('aria-label', 'Edit row 1, Notes: aLICE   SMITH');
    expect(screen.getByRole('button', { name: 'Edit row 2, Notes: BoB SMITH' })).toBeVisible();
    expect(workerRequests.filter(request => request.type === 'clean').at(-1)).toMatchObject({
      options: {
        whitespace: { columns: [1] }, case: { columns: [1], mode: 'upper' },
        replace: { columns: [1], find: 'SMITH', replacement: 'Jones' },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Current' }));
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: aLICE SMITH' })).toHaveAttribute('aria-label', 'Edit row 1, Name: aLICE   SMITH');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: 'Apply fixes' }));
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: ALICE Jones' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: aLICE SMITH' })).toHaveAttribute('aria-label', 'Edit row 1, Name: aLICE   SMITH');
    expect(screen.getByRole('button', { name: 'Edit row 2, Name: BoB SMITH' })).toBeVisible();
  });

  it('invalidates a staged replacement when its text changes and permits replacing with empty text', async () => {
    const user = await openWorkspace('Name,Notes\nAlice [old],Keep [old]');
    await user.click(screen.getByRole('checkbox', { name: /^Find and replace(?!:)/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Find and replace: Name' }));
    await user.click(screen.getByRole('textbox', { name: 'Find text' }));
    await user.paste('[old]');
    await user.click(screen.getByRole('textbox', { name: 'Replacement text' }));
    await user.paste('[new]');
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await screen.findByRole('button', { name: 'Apply fixes' });
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Alice [new]' })).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: 'Replacement text' }));
    expect(screen.queryByRole('button', { name: 'Apply fixes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Alice [old]' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await user.click(await screen.findByRole('button', { name: 'Apply fixes' }));
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Alice' })).toHaveAttribute('aria-label', 'Edit row 1, Name: Alice ');
    expect(screen.getByRole('button', { name: 'Edit row 1, Notes: Keep [old]' })).toBeVisible();
  });

  it('reviews rows removed by a selected key while keeping the first match and blank keys', async () => {
    const user = await openWorkspace('ID,Name\n001,Alice\n001,Alicia\n,Bob\n,Charlie\n002,Dana');
    await user.click(screen.getByRole('checkbox', { name: /^Duplicates by column(?!:)/ }));
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Duplicates by column: ID' }));
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await screen.findByRole('button', { name: 'Apply fixes' });
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^4$/);
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Alice' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit row 2, Name: Alicia' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit row 3, Name: Bob' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 4, Name: Charlie' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Review rows to remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rows to remove' });
    expect(dialog).toHaveTextContent('001');
    expect(dialog).toHaveTextContent('Alicia');
    expect(dialog).not.toHaveTextContent('Bob');
    expect(dialog).not.toHaveTextContent('Charlie');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Apply fixes' }));
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^4$/);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^5$/);
    expect(screen.getByRole('button', { name: 'Edit row 2, Name: Alicia' })).toBeVisible();
  });

  it('defaults to general cleanup, preserving dates, codes, signed numbers, and category casing', async () => {
    const csv = 'SKU,Date,Price,Stock,Category,Notes\nab-001,2026-10-04,0007,-3,eBay, Follow up \nab-001,2026-10-04,0007,-3,eBay, Follow up \nxy-002,04/10/2026,-12.50,0012,iOS,';
    const user = await openWorkspace(csv);
    expect(screen.getByRole('combobox', { name: 'Cleaning preset' })).toHaveTextContent('General cleanup');
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    for (const title of ['Normalize repeated spaces', 'Change text casing', 'Find and replace', 'Duplicates by column']) {
      expect(screen.getByRole('checkbox', { name: new RegExp(`^${title}(?!:)`) })).not.toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: /Trim extra spaces/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Remove exact duplicates/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /Standardize SKUs/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Unify categories/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await screen.findByRole('button', { name: 'Apply fixes' });
    expect(workerRequests.filter(request => request.type === 'clean').at(-1)).toMatchObject({ operations: ['trim', 'duplicates'] });
    await user.click(screen.getByRole('button', { name: 'Apply fixes' }));
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^2$/);
    for (const [row, column, value] of [
      [1, 'SKU', 'ab-001'], [1, 'Date', '2026-10-04'], [1, 'Price', '0007'],
      [1, 'Stock', '-3'], [1, 'Category', 'eBay'], [1, 'Notes', 'Follow up'],
      [3, 'Date', '04/10/2026'], [3, 'Price', '-12.50'], [3, 'Stock', '0012'], [3, 'Category', 'iOS'],
    ]) {
      expect(screen.getByRole('button', { name: `Edit row ${row}, ${column}: ${value}` })).toBeVisible();
    }
    expect(screen.getByTestId('attention-rows')).toHaveTextContent(/^1$/);
    await user.click(screen.getByRole('button', { name: /Review 1 issues in row 3/ }));
    const details = screen.getByRole('region', { name: 'Row review' });
    expect(details).toHaveTextContent('Notes');
    expect(details).toHaveTextContent(/empty|missing/i);
    expect(details).not.toHaveTextContent(/whole number|SKU|category casing|Price/);
  });

  it('requires inventory cleanup to enable inventory rules and discards its preview when returning to general', async () => {
    const user = await openWorkspace('SKU,Category,Price,Stock\nab-001,eBay,-12.50,-3');
    expect(screen.getByTestId('attention-rows')).toHaveTextContent(/^0$/);
    expect(screen.queryByRole('checkbox', { name: /Standardize SKUs/ })).not.toBeInTheDocument();

    await chooseOption(user, 'Cleaning preset', 'Inventory cleanup');
    expect(screen.getByRole('checkbox', { name: /Standardize SKUs/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Unify categories/ })).toBeChecked();
    expect(screen.getByTestId('attention-rows')).toHaveTextContent(/^1$/);
    await user.click(screen.getByRole('button', { name: /Review \d+ issues in row 1/ }));
    expect(screen.getByRole('region', { name: 'Row review' })).toHaveTextContent('Stock: enter a nonnegative whole number.');
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await screen.findByRole('button', { name: 'Apply fixes' });
    expect(screen.getByRole('button', { name: 'Edit row 1, SKU: AB-001' })).toBeVisible();

    await chooseOption(user, 'Cleaning preset', 'General cleanup');
    expect(screen.queryByRole('button', { name: 'Apply fixes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Standardize SKUs/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit row 1, SKU: ab-001' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 1, Category: eBay' })).toBeVisible();
    expect(screen.getByTestId('attention-rows')).toHaveTextContent(/^0$/);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('resets a newly imported file to general cleanup after an inventory preset was customized', async () => {
    const user = await openInventoryWorkspace();
    await user.click(screen.getByRole('checkbox', { name: /Trim extra spaces/ }));
    expect(screen.getByRole('checkbox', { name: /Trim extra spaces/ })).not.toBeChecked();
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([
      'Name,Reference\n Customer ,0012',
    ], 'customers.csv', { type: 'text/csv' }));
    await screen.findByRole('heading', { name: 'customers.csv' });
    expect(screen.getByRole('combobox', { name: 'Cleaning preset' })).toHaveTextContent('General cleanup');
    expect(screen.getByRole('checkbox', { name: /Trim extra spaces/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Remove exact duplicates/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /Standardize SKUs/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await screen.findByRole('button', { name: 'Apply fixes' });
    expect(workerRequests.filter(request => request.type === 'clean').at(-1)).toMatchObject({ operations: ['trim', 'duplicates'] });
    expect(screen.getByRole('button', { name: 'Edit row 1, Name: Customer' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 1, Reference: 0012' })).toBeVisible();
  });

  it('starts empty and enables the cleanup workflow only after a file is imported', async () => {
    const user = await openWorkspace();
    expect(screen.getByRole('heading', { name: 'CSV & Excel spreadsheet cleaner' })).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export file' })).toBeDisabled();
    expect(screen.getByRole('searchbox', { name: 'Search data' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Filter rows' })).toBeDisabled();
    expect(workerRequests).toEqual([]);

    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([
      'SKU,Product name,Price\n rr-1 , Tote ,$5.00',
    ], 'first-inventory.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('heading', { name: 'first-inventory.csv' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Open a spreadsheet' })).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^1$/);
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export file' })).toBeEnabled();
    expect(screen.getByRole('searchbox', { name: 'Search data' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Filter rows' })).toBeEnabled();
  });

  it('shows an import skeleton and locks the workbench until the file worker finishes', async () => {
    const user = await openWorkspace();
    const pending = deferWorker('parse');
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([
      'SKU,Product name\nNEW,Imported product',
    ], 'pending.csv', { type: 'text/csv' }));
    await waitFor(() => expect(workerRequests.at(-1)?.type).toBe('parse'));
    expect(screen.getByTestId('table-loading-skeleton')).toBeInTheDocument();
    const workbench = expectBusyWorkbench('Reading your file…');
    expect(workbench).toHaveTextContent('pending.csv');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export file' })).toBeDisabled();

    await act(async () => { pending.resolve(); });
    expect(await screen.findByRole('heading', { name: 'pending.csv' })).toBeVisible();
    expect(screen.queryByTestId('table-loading-skeleton')).not.toBeInTheDocument();
    expect(workbench).not.toHaveAttribute('inert');
    expect(workbench).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Imported product' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export file' })).toBeEnabled();
  });

  it('clears import loading after a worker error and restores the existing inventory', async () => {
    const user = await openInventoryWorkspace();
    const pending = deferWorker('parse');
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([
      'SKU,Product name\nNEW,Replacement',
    ], 'failed-import.csv', { type: 'text/csv' }));
    await waitFor(() => expect(workerRequests.filter(request => request.type === 'parse')).toHaveLength(2));
    expect(screen.getByTestId('table-loading-skeleton')).toBeInTheDocument();
    const workbench = expectBusyWorkbench('Reading your file…');

    await act(async () => { pending.reject(new Error('The inventory worker could not read this file.')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('The inventory worker could not read this file.');
    expect(screen.queryByTestId('table-loading-skeleton')).not.toBeInTheDocument();
    expect(workbench).not.toHaveAttribute('inert');
    expect(workbench).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('heading', { name: 'inventory.csv' })).toBeVisible();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Canvas Tote Bag' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeEnabled();
  });

  it('keeps the table mounted while preview and report export show compact task progress', async () => {
    const { downloads } = captureDownloads();
    const user = await openInventoryWorkspace();
    const table = screen.getByRole('table');
    const pendingPreview = deferWorker('clean');
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await waitFor(() => expect(workerRequests.at(-1)?.type).toBe('clean'));
    const workbench = expectBusyWorkbench('Preparing your preview…');
    let progress = document.querySelector<HTMLElement>('.task-progress');
    expect(progress).toHaveAttribute('role', 'status');
    expect(progress).toHaveTextContent('Preparing your preview…');
    expect(progress?.querySelector('.rowready-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('table-loading-skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBe(table);
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);

    await act(async () => { pendingPreview.resolve(); });
    await screen.findByRole('button', { name: 'Apply fixes' });
    expect(document.querySelector('.task-progress')).not.toBeInTheDocument();
    expect(workbench).not.toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: 'Apply fixes' }));
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await chooseOption(user, 'Download format', 'PDF — cleanup report');
    const pendingExport = deferWorker('export-pdf');
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(workerRequests.at(-1)?.type).toBe('export-pdf'));
    expectBusyWorkbench('Preparing your cleanup report…');
    progress = document.querySelector<HTMLElement>('.task-progress');
    expect(progress).toHaveTextContent('Preparing your cleanup report…');
    expect(progress?.querySelector('.rowready-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('table-loading-skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBe(table);
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^17$/);
    expect(downloads).toHaveLength(0);

    await act(async () => { pendingExport.resolve(); });
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]!.filename).toBe('inventory-cleanup-report.pdf');
    expect(document.querySelector('.task-progress')).not.toBeInTheDocument();
    expect(workbench).not.toHaveAttribute('inert');
    expect(workbench).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: 'Export file' })).toBeEnabled();
  });

  it('previews an imported inventory, compares current data, applies changes, and undoes them', async () => {
    const user = await openInventoryWorkspace();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);
    expect(screen.getByTestId('attention-rows')).toHaveTextContent(/^10$/);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    expect(await screen.findByText('11 cells changed · 1 duplicate removed')).toBeVisible();
    expect(screen.getByText('2 rows will still need manual review.')).toBeVisible();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^17$/);
    expect(screen.getByRole('button', { name: 'Export file' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Current' }));
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);
    expect(screen.getByRole('button', { name: 'Edit row 2, SKU: rr-1002' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('button', { name: 'Edit row 2, SKU: RR-1002' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Apply fixes' }));
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^17$/);
    expect(screen.getByTestId('attention-rows')).toHaveTextContent(/^2$/);
    expect(screen.queryByRole('button', { name: 'Apply fixes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export file' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);
    expect(screen.getByTestId('attention-rows')).toHaveTextContent(/^10$/);
    expect(screen.getByRole('button', { name: 'Edit row 2, SKU: rr-1002' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('cancels a cell edit with Escape and saves one with Enter', async () => {
    const user = await openInventoryWorkspace();
    const originalLabel = 'Edit row 1, Product name: Canvas Tote Bag';
    await user.click(screen.getByRole('button', { name: originalLabel }));
    const editor = screen.getByRole('textbox', { name: 'Row 1, Product name' });
    await user.clear(editor);
    await user.type(editor, 'Abandoned change');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: originalLabel })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Row 1, Product name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

    await editFirstProduct(user, 'Everyday Tote');
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Everyday Tote' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: originalLabel })).toBeVisible();
  });

  it('filters attention and ready rows, searches across pages, and clears empty results', async () => {
    const user = await openInventoryWorkspace();
    await chooseOption(user, 'Rows per page', '10');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Showing 11–18 of 18 rows')).toBeVisible();
    await chooseOption(user, 'Filter rows', 'Needs attention');
    expect(screen.getByText('Showing 1–10 of 10 rows')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit row 1, SKU: RR-1001' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit row 13, Stock: ten' })).toBeVisible();

    await chooseOption(user, 'Filter rows', 'Ready to go');
    expect(screen.getByText('Showing 1–8 of 8 rows')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit row 13, Stock: ten' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search data' }), 'Travel Journal');
    expect(screen.getByText('Showing 1–1 of 1 rows')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 18, Product name: Travel Journal' })).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: 'Search data' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search data' }), 'does not exist');
    expect(screen.getByRole('heading', { name: 'No matching rows' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('searchbox', { name: 'Search data' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Filter rows' })).toHaveTextContent('All rows');
    expect(screen.getByText('Showing 1–10 of 18 rows')).toBeVisible();
  });

  it('resets pagination when the page size, search, or filter changes while retaining the selected view', async () => {
    const user = await openWorkspace();
    const rows = Array.from({ length: 60 }, (_, index) => {
      const row = index + 1;
      return `RR-${1000 + row},${row <= 40 ? 'Widget' : 'Other'} ${row},${row % 2 ? '' : '1.00'},1`;
    });
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([
      `SKU,Product name,Price,Stock\n${rows.join('\n')}`,
    ], 'pagination.csv', { type: 'text/csv' }));
    await screen.findByText('pagination.csv');
    const pageSize = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(pageSize).toHaveTextContent('25');
    expect(screen.getByText('Showing 1–25 of 60 rows')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Showing 26–50 of 60 rows')).toBeVisible();

    await chooseOption(user, 'Rows per page', '10');
    expect(screen.getByText('Showing 1–10 of 60 rows')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Showing 21–30 of 60 rows')).toBeVisible();

    await user.type(screen.getByRole('searchbox', { name: 'Search data' }), 'Widget');
    expect(screen.getByText('Showing 1–10 of 40 rows')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await chooseOption(user, 'Filter rows', 'Needs attention');
    expect(screen.getByText('Showing 1–10 of 20 rows')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Showing 11–20 of 20 rows')).toBeVisible();

    await chooseOption(user, 'Rows per page', '25');
    expect(screen.getByText('Showing 1–20 of 20 rows')).toBeVisible();
    expect(screen.getByRole('searchbox', { name: 'Search data' })).toHaveValue('Widget');
    expect(screen.getByRole('combobox', { name: 'Filter rows' })).toHaveTextContent('Needs attention');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('opens row issue details, closes them, and clears stale details when the view changes', async () => {
    const user = await openInventoryWorkspace();
    const review = screen.getByRole('button', { name: /Review \d+ issues in row 13/ });
    await user.click(review);
    let details = await screen.findByRole('region', { name: 'Row review' });
    expect(within(details).getByRole('heading', { name: /^Row 13$/ })).toBeVisible();
    expect(details).toHaveTextContent('Stock: enter a nonnegative whole number.');
    await user.click(within(details).getByRole('button', { name: 'Close row details' }));
    expect(within(details).queryByRole('heading', { name: /^Row 13$/ })).not.toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: 'Close row details' })).not.toBeInTheDocument();

    await user.click(review);
    details = await screen.findByRole('region', { name: 'Row review' });
    expect(details).toBeVisible();
    await chooseOption(user, 'Filter rows', 'Ready to go');
    expect(within(details).queryByRole('heading', { name: /^Row 13$/ })).not.toBeInTheDocument();
    expect(details).not.toHaveTextContent('Stock: enter a nonnegative whole number.');
    expect(screen.queryByRole('button', { name: /Review \d+ issues in row 13/ })).not.toBeInTheDocument();
  });

  it('keeps the current inventory when an imported file is malformed', async () => {
    const user = await openInventoryWorkspace();
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File(['SKU,Product\none,two,three'], 'broken.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Data row 1 has 3 cells, but the header has 2.');
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);
    expect(screen.getByText('inventory.csv')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Canvas Tote Bag' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview fixes' })).toBeEnabled();
  });

  it('requires a choice before replacing edits and restores the original only after Continue', async () => {
    const user = await openInventoryWorkspace();
    await editFirstProduct(user, 'Keep this edit');
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([
      'SKU,Product name\nNEW,Replacement inventory',
    ], 'replacement.csv', { type: 'text/csv' }));
    let dialog = await screen.findByRole('dialog', { name: 'Replace this workspace?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'inventory.csv' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'replacement.csv' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Keep this edit' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reset to original file' }));
    dialog = await screen.findByRole('dialog', { name: 'Replace this workspace?' });
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Canvas Tote Bag' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset to original file' })).toBeDisabled();
  });

  it('exports a new CSV with formula protection enabled by default and supports raw export', async () => {
    const { blobs, downloads } = captureDownloads();
    const user = await openWorkspace();
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File(['Name,Code\n=1+1,0012'], 'formulas.csv', { type: 'text/csv' }));
    await screen.findByText('formulas.csv');
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    let dialog = await screen.findByRole('dialog', { name: 'Export your data' });
    expect(within(dialog).getByRole('checkbox', { name: /Protect spreadsheet formulas/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ href: 'blob:rowready-1', filename: 'formulas-cleaned.csv' });
    expect(await blobs[0]!.text()).toBe("\uFEFFName,Code\r\n'=1+1,0012\r\n");
    expect(screen.getByText('formulas.csv')).toBeVisible();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^1$/);

    await user.click(screen.getByRole('button', { name: 'Export file' }));
    dialog = await screen.findByRole('dialog', { name: 'Export your data' });
    await user.click(within(dialog).getByRole('checkbox', { name: /Protect spreadsheet formulas/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(await blobs[1]!.text()).toBe('\uFEFFName,Code\r\n=1+1,0012\r\n');
  });

  it('imports a chosen worksheet and defaults to an Excel download containing text values', async () => {
    const { blobs, downloads } = captureDownloads();
    const user = await openWorkspace();
    const codes = utils.aoa_to_sheet([['SKU', 'Product name', 'Stock'], [42, '=1+1', 7]]);
    codes.A2.z = '000000';
    const file = workbookFile({
      Summary: utils.aoa_to_sheet([['Metric'], ['Not inventory']]),
      Warehouse: codes,
    }, 'warehouse.xlsx');
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), file);
    const worksheetDialog = await screen.findByRole('dialog', { name: 'Choose a worksheet' });
    expect(within(worksheetDialog).getByRole('combobox', { name: 'Worksheet' })).toHaveTextContent('Summary');
    await chooseOption(user, 'Worksheet', 'Warehouse');
    const pending = deferWorker('parse-xlsx');
    await user.click(within(worksheetDialog).getByRole('button', { name: 'Import worksheet' }));
    await waitFor(() => expect(workerRequests.at(-1)?.type).toBe('parse-xlsx'));
    expect(worksheetDialog).toHaveAttribute('aria-busy', 'true');
    expect(within(worksheetDialog).getByRole('combobox', { name: 'Worksheet' })).toBeDisabled();
    expect(within(worksheetDialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    const importButton = within(worksheetDialog).getByRole('button', { name: 'Import worksheet' });
    expect(importButton).toBeDisabled();
    expect(importButton).toHaveTextContent('Reading worksheet…');
    expect(within(worksheetDialog).getByRole('status')).toHaveTextContent('Reading your worksheet…');
    expect(worksheetDialog.querySelector('.rowready-spinner')).toBeInTheDocument();
    expect(screen.getByTestId('table-loading-skeleton')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(worksheetDialog).toBeVisible();

    await act(async () => { pending.resolve(); });

    expect(await screen.findByText('warehouse.xlsx')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-loading-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^1$/);
    expect(screen.getByRole('button', { name: 'Edit row 1, SKU: 000042' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: =1+1' })).toBeVisible();
    expect(screen.getByText(/XLSX · Warehouse · 3 columns/)).toBeVisible();
    expect(screen.getByText('Excel import notes')).toBeVisible();
    expect(workerRequests.filter(request => request.type === 'parse-xlsx')).toEqual([
      expect.objectContaining({ type: 'parse-xlsx', sheetName: 'Warehouse' }),
    ]);

    await user.click(screen.getByRole('button', { name: 'Export file' }));
    const exportDialog = await screen.findByRole('dialog', { name: 'Export your data' });
    expect(within(exportDialog).getByRole('combobox', { name: 'Download format' })).toHaveTextContent('Excel (.xlsx) — spreadsheet data');
    await user.click(within(exportDialog).getByRole('button', { name: 'Download Excel' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ href: 'blob:rowready-1', filename: 'warehouse-Warehouse-cleaned.xlsx' });
    expect(blobs[0]!.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const exported = read(await blobs[0]!.arrayBuffer(), { type: 'array', cellFormula: true });
    expect(exported.SheetNames).toEqual(['Cleaned data']);
    const sheet = exported.Sheets['Cleaned data']!;
    expect(sheet.A2).toMatchObject({ t: 's', v: '000042' });
    expect(sheet.B2).toMatchObject({ t: 's', v: '=1+1' });
    expect(sheet.B2.f).toBeUndefined();
    expect(sheet.C2).toMatchObject({ t: 's', v: '7' });
    expect(screen.getByText('warehouse.xlsx')).toBeVisible();
  });

  it('keeps the current workspace when worksheet selection is canceled', async () => {
    const user = await openInventoryWorkspace();
    await editFirstProduct(user, 'Keep this edit');
    const file = workbookFile({ Inventory: utils.aoa_to_sheet([['SKU'], ['NEW']]) });
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), file);
    const replaceDialog = await screen.findByRole('dialog', { name: 'Replace this workspace?' });
    await user.click(within(replaceDialog).getByRole('button', { name: 'Continue' }));
    const worksheetDialog = await screen.findByRole('dialog', { name: 'Choose a worksheet' });
    await user.click(within(worksheetDialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('inventory.csv')).toBeVisible();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Keep this edit' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    expect(workerRequests.some(request => request.type === 'parse-xlsx')).toBe(false);
  });

  it('inspects a cached Excel formula and exports the edited result as a literal value', async () => {
    const { blobs, downloads } = captureDownloads();
    const user = await openWorkspace();
    const sheet = utils.aoa_to_sheet([['Code', 'Total'], ['001', 10]]);
    sheet.B2 = { t: 'n', f: '5+5', v: 10 };
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), workbookFile({ Financial: sheet }, 'formula-results.xlsx'));
    const worksheetDialog = await screen.findByRole('dialog', { name: 'Choose a worksheet' });
    await user.click(within(worksheetDialog).getByRole('button', { name: 'Import worksheet' }));
    await screen.findByRole('heading', { name: 'formula-results.xlsx' });
    const inspect = screen.getByRole('button', { name: 'Inspect formula in row 1, Total' });
    await user.click(inspect);
    let dialog = await screen.findByRole('dialog', { name: 'Formula details' });
    expect(dialog).toHaveTextContent('B2');
    expect(dialog).toHaveTextContent('=5+5');
    expect(dialog).toHaveTextContent('Saved result');
    expect(dialog).toHaveTextContent('Current value');
    expect(dialog).toHaveTextContent(/not.*recalculat|no recalculation/i);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Edit row 1, Total: 10' }));
    const editor = screen.getByRole('textbox', { name: 'Row 1, Total' });
    await user.clear(editor);
    await user.type(editor, '12');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Inspect formula in row 1, Total' }));
    dialog = await screen.findByRole('dialog', { name: 'Formula details' });
    expect(within(dialog).getByText('10')).toBeVisible();
    expect(within(dialog).getByText('12')).toBeVisible();
    expect(dialog).toHaveTextContent('=5+5');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    const exportDialog = await screen.findByRole('dialog', { name: 'Export your data' });
    expect(exportDialog).toHaveTextContent(/formulas are not preserved or recalculated/i);
    await user.click(within(exportDialog).getByRole('button', { name: 'Download Excel' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    const exported = read(await blobs[0]!.arrayBuffer(), { type: 'array', cellFormula: true });
    const values = exported.Sheets['Cleaned data']!;
    expect(values.A2).toMatchObject({ t: 's', v: '001' });
    expect(values.B2).toMatchObject({ t: 's', v: '12' });
    expect(values.B2.f).toBeUndefined();
  });

  it('keeps the original data when a formula has no saved result and permits another worksheet choice', async () => {
    const user = await openInventoryWorkspace();
    const formula = utils.aoa_to_sheet([['SKU', 'Stock'], ['OLD', 2]]);
    formula.B2 = { t: 'n', f: '1+1' };
    const file = workbookFile({ Formula: formula, Values: utils.aoa_to_sheet([['SKU', 'Stock'], ['NEW', '2']]) });
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), file);
    const dialog = await screen.findByRole('dialog', { name: 'Choose a worksheet' });
    await user.click(within(dialog).getByRole('button', { name: 'Import worksheet' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/B2.*recalculat/i);
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^18$/);
    expect(screen.getByText('inventory.csv')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import worksheet' })).toBeEnabled();

    await chooseOption(user, 'Worksheet', 'Values');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Import worksheet' }));
    expect(await screen.findByRole('button', { name: 'Edit row 1, SKU: NEW' })).toBeVisible();
    expect(screen.getByText('inventory.xlsx')).toBeVisible();
    expect(screen.getByTestId('total-rows')).toHaveTextContent(/^1$/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('exports a PDF report for committed data with undone operations and edits excluded', async () => {
    const { blobs, downloads } = captureDownloads();
    const user = await openWorkspace();
    const csv = 'SKU,Product name\n ab , Tea \nZZ,Coffee';
    await user.upload(screen.getByLabelText('Import CSV, TSV, or Excel'), new File([csv], 'report.csv', { type: 'text/csv' }));
    await screen.findByText('report.csv');
    await chooseOption(user, 'Cleaning preset', 'Inventory cleanup');
    // Apply just trimming, then make one manual edit that should remain in the report.
    await user.click(screen.getByRole('checkbox', { name: /Standardize SKUs/ }));
    await user.click(screen.getByRole('checkbox', { name: /Remove exact duplicates/ }));
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await user.click(await screen.findByRole('button', { name: 'Apply fixes' }));
    await user.click(screen.getByRole('button', { name: 'Edit row 1, Product name: Tea' }));
    await user.clear(screen.getByRole('textbox', { name: 'Row 1, Product name' }));
    await user.type(screen.getByRole('textbox', { name: 'Row 1, Product name' }), 'Green tea');
    await user.keyboard('{Enter}');

    // Apply SKU casing, then a second edit; undo both while leaving that recipe selected.
    await user.click(screen.getByRole('checkbox', { name: /Standardize SKUs/ }));
    await user.click(screen.getByRole('button', { name: 'Preview fixes' }));
    await user.click(await screen.findByRole('button', { name: 'Apply fixes' }));
    await user.click(screen.getByRole('button', { name: 'Edit row 1, Product name: Green tea' }));
    await user.clear(screen.getByRole('textbox', { name: 'Row 1, Product name' }));
    await user.type(screen.getByRole('textbox', { name: 'Row 1, Product name' }), 'Abandoned tea');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Edit row 1, SKU: ab' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit row 1, Product name: Green tea' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Standardize SKUs/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Export file' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export your data' });
    await chooseOption(user, 'Download format', 'PDF — cleanup report');
    await user.click(within(dialog).getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ href: 'blob:rowready-1', filename: 'report-cleanup-report.pdf' });
    expect(blobs[0]!.type).toBe('application/pdf');
    const requests = workerRequests.filter(request => request.type === 'export-pdf');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.report).toEqual({
      filename: 'report.csv', worksheet: undefined, analysisProfile: 'inventory',
      original: parseCSV(csv), current: parseCSV('SKU,Product name\nab,Green tea\nZZ,Coffee'),
      appliedOperations: ['trim'], manualEdits: 1,
      generatedAt: expect.any(String), notes: [],
    });
    expect(Number.isNaN(Date.parse(requests[0]!.report.generatedAt))).toBe(false);
  });
});
