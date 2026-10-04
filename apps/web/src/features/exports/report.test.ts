import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { cleanData, parseCSV, SAMPLE_CSV, PRESETS } from '@rowready/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCleanupReport, summarizeCleanup } from './report';
import type { CleanupReportInput } from './types';

const original = parseCSV(SAMPLE_CSV);
const inventoryOperations = PRESETS.find((preset) => preset.profile === 'inventory')!.operations;
const cleaned = cleanData(original, inventoryOperations).data;
function input(overrides: Partial<CleanupReportInput> = {}): CleanupReportInput {
  return {
    filename: 'inventory.csv', original, current: cleaned, analysisProfile: 'inventory',
    appliedOperations: [...inventoryOperations], manualEdits: 0,
    generatedAt: '2026-10-04T08:15:30.000Z', notes: [], ...overrides,
  };
}

describe('cleanup report metrics', () => {
  it('reports the sample cleanup with unresolved missing price and invalid stock', () => {
    const summary = summarizeCleanup(input());
    expect(summary.before.rows).toBe(18);
    expect(summary.after).toEqual({ rows: 17, needsAttention: 2, readyPercent: 88 });
    expect(summary.changedCells).toBe(11);
    expect(summary.duplicatesRemoved).toBe(1);
    expect(summary.totalIssues).toBe(2);
    expect(summary.issues.map((issue) => issue.rowId)).toEqual([6, 13]);
    expect(summary.operations).toHaveLength(5);
  });

  it('counts net retained-row changes and respects a workspace restored by undo', () => {
    const current = structuredClone(original);
    current.rows[0]!.cells[1] = 'Updated name';
    const summary = summarizeCleanup(input({ current, appliedOperations: [], manualEdits: 1 }));
    expect(summary.changedCells).toBe(1);
    expect(summary.duplicatesRemoved).toBe(0);
    expect(summary.operations).toEqual([]);
    expect(summary.manualEdits).toBe(1);
    expect(summarizeCleanup(input({ current: original, appliedOperations: [], manualEdits: 0 })).changedCells).toBe(0);
  });

  it('uses general checks by default and keeps both snapshot counts within the active profile', () => {
    const dataset = parseCSV('SKU,Price,Stock,Notes\n001,12,unknown,\n002,14,2,ok');
    const current = structuredClone(dataset);
    current.rows[0]!.cells[3] = 'confirmed';
    const general = summarizeCleanup(input({ original: dataset, current, analysisProfile: undefined }));
    expect(general.before).toEqual({ rows: 2, needsAttention: 1, readyPercent: 50 });
    expect(general.after).toEqual({ rows: 2, needsAttention: 0, readyPercent: 100 });
    expect(general.totalIssues).toBe(0);
    const inventory = summarizeCleanup(input({ original: dataset, current, analysisProfile: 'inventory' }));
    expect(inventory.before).toEqual({ rows: 2, needsAttention: 1, readyPercent: 50 });
    expect(inventory.after).toEqual({ rows: 2, needsAttention: 1, readyPercent: 50 });
    expect(inventory.issues.some((issue) => issue.column === 'Stock')).toBe(true);
  });

  it('caps listed issues while retaining the real totals', () => {
    const dataset = parseCSV(`Stock\n${Array.from({ length: 130 }, (_, index) => `invalid-${index}`).join('\n')}`);
    const summary = summarizeCleanup(input({ original: dataset, current: dataset }));
    expect(summary.issues).toHaveLength(100);
    expect(summary.totalIssues).toBe(130);
    expect(summary.after.needsAttention).toBe(130);
    expect(summary.after.readyPercent).toBe(0);
  });

  it('does not count changes in removed rows as retained-cell changes', () => {
    const dataset = parseCSV('SKU,Category\na,home\na,home');
    const current = cleanData(dataset, ['sku', 'category', 'duplicates']).data;
    const summary = summarizeCleanup(input({ original: dataset, current }));
    expect(summary.changedCells).toBe(2);
    expect(summary.duplicatesRemoved).toBe(1);
  });
});

describe('PDF export', () => {
  beforeAll(async () => {
    const fonts = await Promise.all(['Regular', 'Bold'].map(async (weight) => {
      const path = resolve('src/assets/fonts', `NotoSans-${weight}.ttf`);
      return Uint8Array.from(await readFile(path));
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(fonts[url.href.includes('Bold') ? 1 : 0])));
  });
  afterEach(() => { vi.clearAllMocks(); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('creates a valid PDF with source metadata, Unicode names, and a fixed generation date', async () => {
    const buffer = await createCleanupReport(input({ filename: 'Inventário ₱ 東京.xlsx', worksheet: 'Résumé', notes: ['Values imported as text.'] }));
    const pdf = await PDFDocument.load(buffer);
    expect(new TextDecoder().decode(buffer.slice(0, 5))).toBe('%PDF-');
    expect(pdf.getTitle()).toBe('RowReady cleanup report — Inventário ₱ 東京.xlsx');
    expect(pdf.getCreationDate()?.toISOString()).toBe('2026-10-04T08:15:30.000Z');
    expect(pdf.getAuthor()).toBe('RowReady');
    expect(pdf.getSubject()).toBe('Spreadsheet cleanup summary and remaining review items');
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 });
  });

  it('paginates a long review list and wraps long column names without failing', async () => {
    const header = `Very long column ${'name '.repeat(40)}`;
    const dataset = parseCSV(`"${header}"\n${Array.from({ length: 120 }, (_, index) => ` value-${index} `).join('\n')}`);
    const buffer = await createCleanupReport(input({ original: dataset, current: dataset, appliedOperations: [] }));
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    expect(pdf.getPageCount()).toBeLessThan(100);
  });
});
