import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { analyze, RECIPES, type OperationId } from '@rowready/shared';
import type { CleanupReportInput } from './types';

const ISSUE_LIMIT = 100;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const WIDTH = PAGE_WIDTH - MARGIN * 2;
const INK = rgb(0.10, 0.19, 0.22);
const MUTED = rgb(0.37, 0.44, 0.47);
const TEAL = rgb(0.06, 0.29, 0.28);
const MINT = rgb(0.88, 0.96, 0.93);
const PALE = rgb(0.96, 0.97, 0.97);
const LINE = rgb(0.84, 0.89, 0.88);
const AMBER = rgb(0.98, 0.94, 0.84);

export interface ReportIssue { rowId: number; column: string; message: string }
export interface CleanupSummary {
  before: { rows: number; needsAttention: number; readyPercent: number };
  after: { rows: number; needsAttention: number; readyPercent: number };
  changedCells: number;
  duplicatesRemoved: number;
  operations: string[];
  manualEdits: number;
  issues: ReportIssue[];
  totalIssues: number;
}

/** Counts net changes in retained rows, so undo/reverted edits do not inflate the result. */
export function summarizeCleanup(input: CleanupReportInput): CleanupSummary {
  const profile = input.analysisProfile ?? 'general';
  const before = analyze(input.original, profile);
  const after = analyze(input.current, profile);
  const originals = new Map(input.original.rows.map((row) => [row.id, row]));
  const retained = new Set(input.current.rows.map((row) => row.id));
  let changedCells = 0;
  for (const row of input.current.rows) {
    const original = originals.get(row.id);
    if (original) row.cells.forEach((value, col) => { if (value !== original.cells[col]) changedCells++; });
  }
  let totalIssues = 0;
  const issues: ReportIssue[] = [];
  for (const [rowId, rowIssues] of after.issues) {
    for (const issue of rowIssues) {
      totalIssues++;
      if (issues.length < ISSUE_LIMIT) {
        issues.push({ rowId, column: issue.col < 0 ? 'Entire row' : input.current.headers[issue.col] ?? 'Unknown column', message: issue.message });
      }
    }
  }
  const operationSet = new Set<OperationId>(input.appliedOperations);
  const metrics = (analysis: ReturnType<typeof analyze>) => ({
    rows: analysis.total,
    needsAttention: analysis.needsAttention,
    readyPercent: analysis.total ? Math.round(analysis.ready / analysis.total * 100) : 0,
  });
  return {
    before: metrics(before), after: metrics(after), changedCells,
    duplicatesRemoved: input.original.rows.filter((row) => !retained.has(row.id)).length,
    operations: RECIPES.filter((recipe) => operationSet.has(recipe.id)).map((recipe) => recipe.title),
    manualEdits: Math.max(0, Math.floor(input.manualEdits)), issues, totalIssues,
  };
}

let fontBytes: Promise<[ArrayBuffer, ArrayBuffer]> | undefined;
function loadFonts(): Promise<[ArrayBuffer, ArrayBuffer]> {
  fontBytes ??= Promise.all([
    new URL('../../assets/fonts/NotoSans-Regular.ttf', import.meta.url),
    new URL('../../assets/fonts/NotoSans-Bold.ttf', import.meta.url),
  ].map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load the local report fonts. Please try again.');
    return response.arrayBuffer();
  })).then((bytes) => [bytes[0]!, bytes[1]!] as [ArrayBuffer, ArrayBuffer]).catch((error: unknown) => {
    fontBytes = undefined;
    throw error;
  });
  return fontBytes;
}

export async function createCleanupReport(input: CleanupReportInput): Promise<ArrayBuffer> {
  const summary = summarizeCleanup(input);
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await loadFonts();
  const regular = await document.embedFont(regularBytes, { subset: true });
  const bold = await document.embedFont(boldBytes, { subset: true });
  const boldCharacters = new Set(bold.getCharacterSet());
  const supported = new Set(regular.getCharacterSet().filter((code) => boldCharacters.has(code)));
  let substitutedGlyphs = false;
  let shortenedText = false;
  function printable(value: string, maxLength = 2000): string {
    const characters = [...value.normalize('NFC').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/\r\n?/g, '\n')];
    if (characters.length > maxLength) shortenedText = true;
    return characters.slice(0, maxLength).map((character) => {
      if (character === '\n' || character === '\t') return character === '\t' ? ' ' : character;
      if (supported.has(character.codePointAt(0)!)) return character;
      substitutedGlyphs = true;
      return '?';
    }).join('') + (characters.length > maxLength ? '...' : '');
  }
  const filename = printable(input.filename, 500);
  const worksheet = input.worksheet ? printable(input.worksheet, 300) : undefined;
  const notes = input.notes.map((note) => printable(note));
  const issues = summary.issues.map((issue) => ({ ...issue, column: printable(issue.column, 500), message: printable(issue.message, 1000) }));
  const generated = new Date(input.generatedAt);
  const validDate = Number.isNaN(generated.getTime()) ? new Date() : generated;
  document.setTitle(`RowReady cleanup report — ${input.filename}`);
  document.setAuthor('RowReady');
  document.setSubject('Spreadsheet cleanup summary and remaining review items');
  document.setCreator('RowReady · local browser export');
  document.setProducer('RowReady');
  document.setCreationDate(validDate);
  document.setModificationDate(validDate);

  let page: PDFPage;
  let y = 0;
  const pages: PDFPage[] = [];
  function text(value: string, x: number, top: number, size = 10, font = regular, color = INK): void {
    page.drawText(value, { x, y: top - size, size, font, color });
  }
  function rectangle(x: number, top: number, width: number, height: number, color: ReturnType<typeof rgb>): void {
    page.drawRectangle({ x, y: top - height, width, height, color });
  }
  function newPage(): void {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    rectangle(0, PAGE_HEIGHT, PAGE_WIDTH, 7, TEAL);
    text('RowReady', MARGIN, PAGE_HEIGHT - 25, 15, bold, TEAL);
    const label = 'SPREADSHEET CLEANUP REPORT';
    text(label, PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize(label, 8), PAGE_HEIGHT - 29, 8, bold, MUTED);
    y = PAGE_HEIGHT - 77;
  }
  function ensure(height: number): void { if (y - height < 57) newPage(); }
  function wrap(value: string, width: number, size = 10, font: PDFFont = regular): string[] {
    const lines: string[] = [];
    for (const paragraph of value.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        const trial = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(trial, size) <= width) { line = trial; continue; }
        if (line) { lines.push(line); line = ''; }
        for (const character of word) {
          if (line && font.widthOfTextAtSize(line + character, size) > width) { lines.push(line); line = ''; }
          line += character;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  function paragraph(value: string, options: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}): void {
    const { size = 10, font = regular, color = INK, indent = 0, gap = 8 } = options;
    for (const line of wrap(value, WIDTH - indent, size, font)) {
      ensure(size * 1.5);
      text(line, MARGIN + indent, y, size, font, color);
      y -= size * 1.5;
    }
    y -= gap;
  }
  function heading(value: string): void {
    ensure(44);
    y -= 8;
    paragraph(value, { size: 13, font: bold, color: TEAL, gap: 10 });
  }

  newPage();
  paragraph('Spreadsheet cleanup', { size: 25, font: bold, color: TEAL, gap: 0 });
  paragraph('Report of applied changes', { size: 13, color: MUTED, gap: 17 });
  paragraph(filename, { size: 12, font: bold, gap: 3 });
  if (worksheet) paragraph(`Worksheet: ${worksheet}`, { size: 9, color: MUTED, gap: 3 });
  paragraph(`Generated ${validDate.toISOString().replace('T', ' ').slice(0, 19)} UTC`, { size: 9, color: MUTED, gap: 3 });
  paragraph(`Active checks: ${input.analysisProfile === 'inventory' ? 'Inventory cleanup' : 'General cleanup'}`, { size: 9, font: bold, color: MUTED, gap: 16 });

  const statsHeight = 115;
  ensure(statsHeight + 25);
  rectangle(MARGIN, y, WIDTH, statsHeight, PALE);
  text('WORKSPACE SNAPSHOT', MARGIN + 15, y - 13, 8, bold, MUTED);
  text('Original', MARGIN + 272, y - 13, 9, bold, MUTED);
  text('Current', MARGIN + 394, y - 13, 9, bold, TEAL);
  const metricRows = [
    ['Rows', summary.before.rows.toLocaleString('en-US'), summary.after.rows.toLocaleString('en-US')],
    ['Rows needing review', summary.before.needsAttention.toLocaleString('en-US'), summary.after.needsAttention.toLocaleString('en-US')],
    ['Rows passing current checks', `${summary.before.readyPercent}%`, `${summary.after.readyPercent}%`],
  ];
  metricRows.forEach(([label, before, after], index) => {
    const top = y - 39 - index * 24;
    text(label!, MARGIN + 15, top, 10);
    text(before!, MARGIN + 272, top, 11);
    text(after!, MARGIN + 394, top, 11, bold, TEAL);
  });
  y -= statsHeight + 17;
  const status = summary.after.needsAttention
    ? `${summary.after.needsAttention.toLocaleString('en-US')} ${summary.after.needsAttention === 1 ? 'row still needs' : 'rows still need'} your review.`
    : 'No remaining issues were detected by the current checks.';
  const statusLines = wrap(status, WIDTH - 30, 11, bold);
  const statusHeight = statusLines.length * 16 + 23;
  ensure(statusHeight);
  rectangle(MARGIN, y, WIDTH, statusHeight, summary.after.needsAttention ? AMBER : MINT);
  statusLines.forEach((line, index) => text(line, MARGIN + 15, y - 11 - index * 16, 11, bold, TEAL));
  y -= statusHeight + 12;
  paragraph(input.analysisProfile === 'inventory'
    ? 'Checks cover supported inventory patterns, extra spaces, and exact duplicate rows. Passing them does not verify business accuracy.'
    : 'Checks flag extra spaces, exact duplicate rows, and blank values. Blank values may be intentional; no business rules are assumed.', { size: 8.5, color: MUTED, gap: 6 });

  heading('What changed');
  paragraph(`${summary.changedCells.toLocaleString('en-US')} ${summary.changedCells === 1 ? 'cell' : 'cells'} changed in retained rows · ${summary.duplicatesRemoved.toLocaleString('en-US')} duplicate ${summary.duplicatesRemoved === 1 ? 'row' : 'rows'} removed`, { size: 11, font: bold });
  paragraph('Cell changes compare the original import with the current applied workspace. Pending previews are excluded.', { size: 9, color: MUTED });
  paragraph(`Applied steps: ${summary.operations.length ? summary.operations.join('; ') : 'None'}.`, { size: 10 });
  paragraph(`Manual cell edits in the current workspace history: ${summary.manualEdits.toLocaleString('en-US')}.`, { size: 10 });

  heading('File notes');
  paragraph('Prepared locally in your browser. The report contains summary metrics and review details; it does not include a copy of your data.', { size: 9, color: MUTED });
  for (const note of notes) paragraph(`• ${note}`, { size: 9, indent: 6, gap: 5 });
  if (substitutedGlyphs) paragraph('• Some characters are not supported by the report font and appear as ?. Your source data and spreadsheet export are unchanged.', { size: 9, indent: 6, gap: 5 });
  if (shortenedText) paragraph('• Very long file names, notes, column labels, or issue messages are shortened with ... in this report.', { size: 9, indent: 6, gap: 5 });

  if (summary.totalIssues) newPage();
  heading('Remaining review items');
  if (!summary.totalIssues) {
    paragraph('There are no remaining review items to list. Check your source records before using the cleaned data.', { size: 10 });
  } else {
    paragraph(`${summary.totalIssues.toLocaleString('en-US')} ${summary.totalIssues === 1 ? 'issue' : 'issues'} across ${summary.after.needsAttention.toLocaleString('en-US')} ${summary.after.needsAttention === 1 ? 'row' : 'rows'}. Row IDs refer to data rows in the original imported table, excluding its header.`, { size: 9, color: MUTED });
    if (summary.totalIssues > ISSUE_LIMIT) {
      paragraph(`Showing the first ${ISSUE_LIMIT} of ${summary.totalIssues.toLocaleString('en-US')} issues. ${ (summary.totalIssues - ISSUE_LIMIT).toLocaleString('en-US')} additional issues are omitted; review the full list in RowReady.`, { size: 10, font: bold, color: TEAL });
    }
    const rowX = MARGIN + 9;
    const columnX = MARGIN + 61;
    const messageX = MARGIN + 197;
    const lineHeight = 12;
    function tableHeader(): void {
      ensure(68);
      rectangle(MARGIN, y, WIDTH, 25, TEAL);
      text('ROW ID', rowX, y - 7, 8, bold, rgb(1, 1, 1));
      text('COLUMN', columnX, y - 7, 8, bold, rgb(1, 1, 1));
      text('REVIEW DETAIL', messageX, y - 7, 8, bold, rgb(1, 1, 1));
      y -= 25;
    }
    tableHeader();
    issues.forEach((issue, index) => {
      const columnLines = wrap(issue.column, 125, 8.5);
      const messageLines = wrap(issue.message, WIDTH - 209, 8.5);
      let offset = 0;
      const lines = Math.max(columnLines.length, messageLines.length);
      while (offset < lines) {
        if (y < 95) { newPage(); tableHeader(); }
        const availableLines = Math.max(1, Math.floor((y - 72) / lineHeight));
        const count = Math.min(lines - offset, availableLines);
        const height = count * lineHeight + 15;
        if (index % 2 === 0) rectangle(MARGIN, y, WIDTH, height, PALE);
        text(`${issue.rowId}${offset ? ' cont.' : ''}`, rowX, y - 8, 8.5, bold, TEAL);
        for (let line = 0; line < count; line++) {
          const top = y - 8 - line * lineHeight;
          if (columnLines[offset + line]) text(columnLines[offset + line]!, columnX, top, 8.5);
          if (messageLines[offset + line]) text(messageLines[offset + line]!, messageX, top, 8.5);
        }
        page.drawLine({ start: { x: MARGIN, y: y - height }, end: { x: PAGE_WIDTH - MARGIN, y: y - height }, thickness: 0.5, color: LINE });
        y -= height;
        offset += count;
        if (offset < lines) { newPage(); tableHeader(); }
      }
    });
  }

  pages.forEach((reportPage, index) => {
    reportPage.drawLine({ start: { x: MARGIN, y: 41 }, end: { x: PAGE_WIDTH - MARGIN, y: 41 }, thickness: 0.5, color: LINE });
    reportPage.drawText('RowReady · Local file cleanup', { x: MARGIN, y: 25, size: 8, font: regular, color: MUTED });
    const pageLabel = `${index + 1} / ${pages.length}`;
    reportPage.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(pageLabel, 8), y: 25, size: 8, font: regular, color: MUTED });
  });
  return Uint8Array.from(await document.save()).buffer;
}
