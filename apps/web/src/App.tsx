import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpRight, Check, ChevronLeft, ChevronRight, FileSpreadsheet, FolderOpen, ListFilter, MousePointer2, RotateCcw, ScanLine, Search, SlidersHorizontal, Table2, Undo2, X } from 'lucide-react';
import { analyze, columnKinds, validateCleanupOptions, type AnalysisProfile, type CsvRow, type OperationId } from '@rowready/shared';
import { Button } from '@/components/ui/button';
import { Dropdown } from '@/components/ui/dropdown';
import { ReviewSkeleton, Spinner, SummarySkeleton, TableSkeleton } from '@/components/ui/loading';
import { Toaster, useToasts } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { API_URL, getCatalog, LOCAL_CATALOG, validateRecipe } from '@/lib/api';
import { createWorkspace, workspaceReducer } from '@/features/workspace/state';
import { runWorker } from '@/features/workspace/worker-client';
import { useWebMCP } from '@/lib/webmcp';
import type { WorkbookSheet } from '@/features/workspace/excel';
import { CleaningOptions, createCleanupOptions, isConfigurableOperation } from '@/features/workspace/cleaning-options';

function columnLetter(index: number): string {
  let label = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label;
  return label;
}
type Filter = 'all' | 'issues' | 'ready' | 'changed';
type Modal = 'help' | 'export' | 'confirm' | 'worksheet' | 'formula' | 'removed' | null;
type ExportFormat = 'csv' | 'xlsx' | 'pdf';
type LoadingTask = { kind: 'import' | 'preview' | 'export'; label: string; filename?: string };

function ActionButton({ children, secondary = false, className = '', ...props }: React.ComponentProps<typeof Button> & { secondary?: boolean }) {
  return <Button {...props} className={`button ${secondary ? 'button-subtle' : 'button-dark'} ${className}`}>{children}</Button>;
}
function ModalBody({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</>;
}
function CellEditor({ value, label, onSave, onCancel }: { value: string; label: string; onSave: (value: string, restoreFocus: boolean) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(value);
  const finished = useRef(false);
  const finish = (save: boolean, restoreFocus = false) => {
    if (finished.current) return;
    finished.current = true;
    if (save) onSave(draft, restoreFocus); else onCancel();
  };
  return <textarea autoFocus className="cell-editor" value={draft} maxLength={100_000} aria-label={label} rows={Math.min(4, Math.max(1, draft.split('\n').length))}
    title="Enter to save · Shift+Enter for a new line · Escape to cancel" onFocus={event => event.currentTarget.select()}
    onChange={event => setDraft(event.target.value)} onBlur={() => finish(true)} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false, true); }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true, true); }
    }} />;
}

export function App() {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createWorkspace);
  const [catalog, setCatalog] = useState(LOCAL_CATALOG);
  const [analysisProfile, setAnalysisProfile] = useState<AnalysisProfile>('general');
  const [selected, setSelected] = useState<OperationId[]>(['trim', 'duplicates']);
  const [cleanupOptions, setCleanupOptions] = useState(createCleanupOptions);
  const [formulaTarget, setFormulaTarget] = useState<{ rowId: number; col: number } | null>(null);
  const [removedPage, setRemovedPage] = useState(1);
  const [preview, setPreview] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [error, setError] = useState('');
  const { toasts, notify, dismiss, dismissAll } = useToasts();
  const [modal, setModal] = useState<Modal>(null);
  const [safeExport, setSafeExport] = useState(true);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [pendingWorkbook, setPendingWorkbook] = useState<{ file: File; sheets: WorkbookSheet[] } | null>(null);
  const [worksheet, setWorksheet] = useState('');
  const [worksheetError, setWorksheetError] = useState('');
  const [loading, setLoading] = useState<LoadingTask | null>(null);
  const [editing, setEditing] = useState<{ rowId: number; col: number } | null>(null);
  const [issueRow, setIssueRow] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const taskRunning = useRef(false);
  const confirmAction = useRef<(() => void) | null>(null);
  const data = state.stage && preview ? state.stage.data : state.data;
  const importing = state.busy && loading?.kind === 'import';
  const hasFile = state.data.headers.length > 0;
  const dirty = state.data !== state.original;
  const report = useMemo(() => analyze(data, analysisProfile), [data, analysisProfile]);
  const kinds = useMemo(() => columnKinds(state.data.headers), [state.data.headers]);
  const available = (id: OperationId) => hasFile && (id === 'trim' || id === 'duplicates' || isConfigurableOperation(id) || analysisProfile === 'inventory' && kinds.includes(id));
  const visibleOperations = catalog.operations.filter(operation => analysisProfile === 'inventory' || operation.id === 'trim' || operation.id === 'duplicates' || isConfigurableOperation(operation.id));
  const operations = selected.filter(available);
  let optionsError = '';
  try { validateCleanupOptions(state.data, operations, cleanupOptions); }
  catch (cause) { optionsError = cause instanceof Error ? cause.message : 'Choose columns and settings for each selected step.'; }
  const selectedPreset = catalog.recipes.find(recipe => {
    if (recipe.profile !== analysisProfile) return false;
    const applicable = recipe.operations.filter(available);
    return applicable.length === operations.length && applicable.every(operation => operations.includes(operation));
  });
  const changedRows = useMemo(() => new Set(state.stage?.changes.map(change => change.rowId) ?? []), [state.stage]);
  const changes = useMemo(() => new Map((state.stage && preview ? state.stage.changes : []).map(change => [`${change.rowId}:${change.col}`, change])), [state.stage, preview]);
  const effectiveFilter = filter === 'changed' && !state.stage ? 'all' : filter;
  const filteredRows = useMemo(() => data.rows.filter(row => {
    if (effectiveFilter === 'issues' && !report.issues.has(row.id)) return false;
    if (effectiveFilter === 'ready' && report.issues.has(row.id)) return false;
    if (effectiveFilter === 'changed' && !changedRows.has(row.id)) return false;
    return row.cells.some(value => value.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  }), [data, effectiveFilter, report, changedRows, search]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const displayedRows = filteredRows.slice(start, start + pageSize);
  const readyPercent = report.total ? Math.round(report.ready / report.total * 100) : 0;
  const currentIssues = issueRow === null ? [] : report.issues.get(issueRow) ?? [];
  const formulaRow = formulaTarget ? data.rows.find(row => row.id === formulaTarget.rowId) : undefined;
  const formulaCell = formulaTarget ? formulaRow?.formulas?.[formulaTarget.col] : undefined;
  const formulaCount = useMemo(() => state.data.rows.reduce((count, row) => count + Object.keys(row.formulas ?? {}).length, 0), [state.data]);

  useEffect(() => {
    const controller = new AbortController();
    void getCatalog(controller.signal).then(setCatalog).catch(() => { /* Bundled presets remain available offline. */ });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!dirty && !state.stage) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, state.stage]);
  useEffect(() => { setPage(1); setIssueRow(null); }, [search, filter, analysisProfile]);
  useEffect(() => { setIssueRow(null); }, [data]);
  useEffect(() => {
    const preventDrop = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', preventDrop);
    window.addEventListener('drop', preventDrop);
    return () => { window.removeEventListener('dragover', preventDrop); window.removeEventListener('drop', preventDrop); };
  }, []);

  function openModal(next: Modal) {
    dialogReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModal(next);
  }
  function focusCell(rowId: number, col: number) {
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-cell="${rowId}:${col}"]`)?.focus());
  }
  function reportError(message: string) { setError(message); notify(message, 'error', 'error'); }
  function clearStage(message?: string) {
    dispatch({ type: 'discard' }); setPreview(true); dismissAll();
    if (filter === 'changed') setFilter('all');
    if (message) notify(message, 'info', 'action');
    else if (state.stage) notify('Preview cleared. Preview your updated steps again.', 'info', 'action');
  }
  function confirmReplace(action: () => void) {
    if (taskRunning.current) return;
    if (dirty || state.stage) { confirmAction.current = action; openModal('confirm'); }
    else action();
  }
  async function task<T>(details: LoadingTask, work: () => Promise<T>) {
    if (taskRunning.current) return;
    taskRunning.current = true;
    dispatch({ type: 'busy', value: true });
    setLoading(details); setError(''); dismissAll(); setEditing(null);
    try { return await work(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Something went wrong. Try again.';
      reportError(message); return { error: message };
    }
    finally {
      taskRunning.current = false; dispatch({ type: 'busy', value: false }); setLoading(null);
      requestAnimationFrame(() => {
        if (document.querySelector('[role="dialog"]')) return;
        const target = details.kind === 'import' ? document.getElementById('inventory-table')
          : details.kind === 'preview' ? document.getElementById('preview-review') ?? document.querySelector<HTMLButtonElement>('[aria-label="Preview fixes"]')
          : document.querySelector<HTMLButtonElement>('[aria-label="Export file"]');
        target?.focus();
      });
    }
  }
  function finishImport() {
    setSearch(''); setFilter('all'); setPreview(true); setPage(1);
    setAnalysisProfile('general'); setSelected(['trim', 'duplicates']);
    setCleanupOptions(createCleanupOptions()); setFormulaTarget(null); setRemovedPage(1);
  }
  function importFile(file?: File) {
    if (!file || taskRunning.current) return;
    if (!/\.(csv|tsv|xlsx)$/i.test(file.name)) { reportError('Choose a CSV, TSV, or Excel (.xlsx) file.'); return; }
    if (file.size > 5 * 1024 * 1024) { reportError('This file is larger than 5 MB. Try a smaller export.'); return; }
    confirmReplace(() => { void task({ kind: 'import', label: 'Reading your file…', filename: file.name }, async () => {
      if (/\.xlsx$/i.test(file.name)) {
        const sheets = await runWorker({ type: 'inspect-xlsx', buffer: await file.arrayBuffer() });
        const firstVisible = sheets.find(sheet => !sheet.hidden);
        if (!firstVisible) throw new Error('This workbook has no visible worksheets to import.');
        setPendingWorkbook({ file, sheets }); setWorksheet(firstVisible.name); setWorksheetError(''); setModal('worksheet');
      } else {
        const result = await runWorker({ type: 'parse', buffer: await file.arrayBuffer() });
        dispatch({ type: 'load', data: result, filename: file.name, source: { format: result.delimiter === '\t' ? 'tsv' : 'csv', notes: [] } });
        finishImport(); setExportFormat('csv');
        notify(`${result.rows.length.toLocaleString()} rows imported. Your file stayed on this device.`, 'success', 'action');
      }
    }); });
  }
  async function importSelectedWorksheet() {
    if (!pendingWorkbook || !worksheet || taskRunning.current) return;
    const pending = pendingWorkbook;
    setWorksheetError('');
    const result = await task({ kind: 'import', label: 'Reading your worksheet…', filename: `${pending.file.name} · ${worksheet}` }, async () => {
      const imported = await runWorker({ type: 'parse-xlsx', buffer: await pending.file.arrayBuffer(), sheetName: worksheet });
      dispatch({ type: 'load', data: imported.data, filename: pending.file.name, source: { format: 'xlsx', worksheet, notes: imported.notes } });
      finishImport(); setExportFormat('xlsx'); setPendingWorkbook(null); setModal(null);
      notify(`${imported.data.rows.length.toLocaleString()} rows imported from ${worksheet}.`, 'success', 'action');
      return { imported: true };
    });
    if (result && 'error' in result) setWorksheetError(result.error);
  }
  function previewFixes() {
    if (!hasFile || !operations.length || optionsError) return;
    return task({ kind: 'preview', label: 'Preparing your preview…' }, async () => {
      await validateRecipe({ version: 1, operations });
      const result = await runWorker({ type: 'clean', data: state.data, operations, options: cleanupOptions });
      dispatch({ type: 'preview', result, operations }); setPreview(true); setPage(1); setFilter('all');
      const hasChanges = !!(result.changes.length || result.removed.length);
      notify(hasChanges ? 'Preview ready. Review the changes before applying.' : 'No changes needed for the selected steps.', hasChanges ? 'success' : 'info', 'action');
      return { changedCells: result.changes.length, removedRows: result.removed.length, remainingRowsNeedingReview: analyze(result.data, analysisProfile).needsAttention };
    });
  }
  function applyFixes() { dispatch({ type: 'apply' }); setFilter('all'); notify('Fixes applied. You can undo this.', 'success', 'action'); requestAnimationFrame(() => document.getElementById('inventory-table')?.focus()); }
  function undo() { dispatch({ type: 'undo' }); setFilter('all'); notify('Last change undone.', 'success', 'action'); }
  function reset() { confirmReplace(() => { dispatch({ type: 'reset' }); setFilter('all'); setError(''); dismissAll(); notify('Original file restored.', 'success', 'action'); }); }
  function editCell(row: CsvRow, col: number, value: string) {
    const current = state.data.rows.find(item => item.id === row.id);
    if (state.busy || taskRunning.current || state.stage || !current || !Number.isInteger(col) || col < 0 || col >= current.cells.length || value.length > 100_000 || current.cells[col] === value) {
      setEditing(null); return;
    }
    dispatch({ type: 'edit', rowId: row.id, col, value }); setEditing(null);
    notify(`${state.data.headers[col]} updated in row ${row.id}.`, 'success', 'edit');
  }
  function download() {
    if (!hasFile || state.stage) return;
    setModal(null);
    void task({ kind: 'export', label: exportFormat === 'pdf' ? 'Preparing your cleanup report…' : 'Preparing your download…' }, async () => {
      let blob: Blob;
      if (exportFormat === 'xlsx') {
        const buffer = await runWorker({ type: 'export-xlsx', data: state.data });
        blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      } else if (exportFormat === 'pdf') {
        const buffer = await runWorker({ type: 'export-pdf', report: {
          filename: state.filename, worksheet: state.source.worksheet, analysisProfile, original: state.original, current: state.data,
          appliedOperations: state.appliedOperations, manualEdits: state.manualEdits, generatedAt: new Date().toISOString(), notes: state.source.notes,
        } });
        blob = new Blob([buffer], { type: 'application/pdf' });
      } else {
        const csv = await runWorker({ type: 'export', data: state.data, safe: safeExport });
        blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
      }
      const url = URL.createObjectURL(blob);
      const base = state.filename.replace(/\.(csv|tsv|xlsx)$/i, '');
      const sheetSuffix = state.source.worksheet ? `-${state.source.worksheet.replace(/[\\/:*?"<>|]/g, '-')}` : '';
      const link = document.createElement('a'); link.href = url;
      link.download = `${(base + sheetSuffix).slice(0, 180)}-${exportFormat === 'pdf' ? 'cleanup-report' : 'cleaned'}.${exportFormat}`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`${exportFormat === 'pdf' ? 'Cleanup report' : exportFormat.toUpperCase()} exported. Your workspace is still here until you leave.`, 'success', 'action');
    });
  }

  function assertIdle() {
    if (taskRunning.current || state.busy) throw new Error('Wait for the current file operation to finish.');
  }
  useWebMCP({
    inspect: () => {
      const current = analyze(state.data, analysisProfile);
      return { filename: state.filename, analysisProfile, columns: state.data.headers, totalRows: current.total, needsAttention: current.needsAttention, ready: current.ready, hasPreview: !!state.stage, undoSteps: state.history.length, busy: state.busy, issues: [...current.issues].slice(0, 20).map(([rowId, issues]) => ({ rowId, issues })) };
    },
    preview: () => { assertIdle(); if (!hasFile) throw new Error('Open a spreadsheet first.'); if (!operations.length) throw new Error('Select at least one cleaning step.'); if (optionsError) throw new Error(optionsError); return previewFixes(); },
    apply: () => { assertIdle(); if (!state.stage) throw new Error('Preview your fixes before applying them.'); const totalRows = state.stage.data.rows.length; applyFixes(); return { applied: true, totalRows }; },
    undo: () => { assertIdle(); if (!state.history.length) throw new Error('There is no change to undo.'); undo(); return { undone: true }; },
    edit: (rowId, column, value) => {
      assertIdle();
      if (state.stage) throw new Error('Apply or discard the preview before editing.');
      const row = state.data.rows.find(item => item.id === rowId);
      if (!row || column >= state.data.headers.length) throw new Error('Choose a valid row and column.');
      editCell(row, column, value); return { edited: row.cells[column] !== value, rowId, column };
    },
  });

  return <>
    <a className="skip-link" href="#workspace">Skip to data</a>
    <a className="skip-link skip-tools" href="#cleaning-tools">Skip to cleaning steps</a>
    <div className="workbench" inert={state.busy || undefined} aria-busy={state.busy}
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
      onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (event.dataTransfer.files.length > 1) reportError('Import one spreadsheet at a time.'); else importFile(event.dataTransfer.files[0]); }}>
      <header className="app-header">
        <a className="brand" href="./" aria-label="RowReady home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>RowReady</a>
        <span className="header-divider" aria-hidden="true" />
        <span className="app-purpose">Spreadsheet workbench</span>
        <div className="header-actions"><a className="text-button" href={`${API_URL}/api/docs`} target="_blank" rel="noreferrer">API docs<ArrowUpRight aria-hidden="true" /></a><button className="text-button" aria-label="How to use RowReady" onClick={() => openModal('help')}>Help</button></div>
      </header>
      <main className="workspace" id="workspace" tabIndex={-1}>
        <div className="document-bar">
          <div className="document-info"><FileSpreadsheet className="document-icon" aria-hidden="true" /><div className="document-title"><h1 title={state.filename || undefined}>{state.filename || 'No file open'}</h1><div className="document-meta"><span>{hasFile ? <>{state.source.format.toUpperCase()}{state.source.worksheet ? ` · ${state.source.worksheet}` : ''} · {data.headers.length} columns · {dirty ? 'Modified' : 'Original file'}</> : 'CSV, TSV, or Excel (.xlsx)'}</span></div></div></div>
          <div className="document-actions">
            <ActionButton secondary aria-label="Open spreadsheet file" onClick={() => fileInput.current?.click()}><FolderOpen aria-hidden="true" /><span>Open file</span></ActionButton>
            <span className="header-divider" aria-hidden="true" />
            <button className="icon-button" aria-label="Undo" title="Undo last change" disabled={!state.history.length || state.busy} onClick={undo}><Undo2 aria-hidden="true" /></button>
            <button className="icon-button" aria-label="Reset to original file" title="Reset to original file" disabled={!dirty && !state.stage} onClick={reset}><RotateCcw aria-hidden="true" /></button>
            <ActionButton aria-label="Export file" disabled={!hasFile || !!state.stage || state.busy} onClick={() => openModal('export')} title={!hasFile ? 'Open a spreadsheet first.' : state.stage ? 'Apply or discard your preview before exporting.' : 'Export current data'}><ArrowDownToLine aria-hidden="true" />Export</ActionButton>
          </div>
        </div>
        <input ref={fileInput} type="file" aria-label="Import CSV, TSV, or Excel" accept=".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={event => { importFile(event.target.files?.[0]); event.target.value = ''; }} />
        {error && modal !== 'worksheet' && <div className="message error-message" role="alert"><AlertTriangle aria-hidden="true" /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X aria-hidden="true" /></button></div>}
        <div className="workspace-body">
          <section className="sheet-area" aria-label="Spreadsheet worksheet">
            <div className="quality-strip" aria-label="Data quality summary">{importing ? <SummarySkeleton /> : <><span className="metric"><strong data-testid="total-rows">{report.total.toLocaleString()}</strong> rows</span><span className="metric">{data.headers.length} columns</span><span className={`metric${report.needsAttention ? ' metric-warning' : ''}`}><i aria-hidden="true" /><strong data-testid="attention-rows">{report.needsAttention.toLocaleString()}</strong> need review</span>{hasFile && <span className="quality-note">{readyPercent}% ready</span>}</>}</div>
            <div className="table-toolbar">
              <span className="table-view-label"><Table2 aria-hidden="true" />Table</span>
              {state.stage && <div className="view-switch" aria-label="Compare data"><button className={!preview ? 'active' : ''} aria-pressed={!preview} onClick={() => setPreview(false)}>Current</button><button className={preview ? 'active' : ''} aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></div>}
              <label className="search-field"><Search aria-hidden="true" /><input type="search" disabled={!hasFile} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search rows…" aria-label="Search data" /></label>
              <div className="filter-field"><ListFilter aria-hidden="true" /><Dropdown className="filter-select" aria-label="Filter rows" disabled={!hasFile} value={effectiveFilter} onValueChange={value => setFilter(value as Filter)} options={[
                { value: 'all', label: 'All rows' },
                { value: 'issues', label: 'Needs attention' },
                { value: 'ready', label: 'Ready to go' },
                { value: 'changed', label: 'Changed in preview', disabled: !state.stage },
              ]} /></div>
              <button className="icon-button tools-shortcut" aria-label="Go to cleaning steps" title="Cleaning steps" onClick={() => { document.getElementById('cleaning-tools')?.focus(); }}><SlidersHorizontal aria-hidden="true" /></button>
            </div>
            {state.stage && !importing && <div className="preview-banner" id="preview-review" tabIndex={-1} role="status"><div className="preview-summary"><strong>{state.stage.changes.length} cells changed · {state.stage.removed.length} {state.stage.removed.length === 1 ? 'duplicate' : 'duplicates'} removed</strong><span>{analyze(state.stage.data, analysisProfile).needsAttention} rows will still need manual review.</span>{state.stage.removed.length > 0 && <button className="review-removed" onClick={() => { setRemovedPage(1); openModal('removed'); }}>Review rows to remove</button>}</div><div className="preview-actions"><ActionButton secondary onClick={() => { clearStage('Preview discarded. Your data is unchanged.'); requestAnimationFrame(() => document.getElementById('inventory-table')?.focus()); }}>Discard</ActionButton><ActionButton onClick={applyFixes}>Apply fixes</ActionButton></div></div>}
            {formulaCount > 0 && !importing && <div className="formula-notice"><span className="formula-mark" aria-hidden="true">fx</span><span>{formulaCount} {formulaCount === 1 ? 'formula result' : 'formula results'} imported as saved values. They may be outdated and will not recalculate. Select <strong>fx</strong> to inspect.</span></div>}
            {importing && <div className="import-progress"><Spinner size="small" /><div><strong>{loading.label}</strong><span title={loading.filename}>{loading.filename}</span></div><small>Processing on this device</small></div>}
            <div className={`table-scroll${!hasFile && !importing ? ' awaiting-file' : ''}${importing ? ' is-loading' : ''}`} id="inventory-table" tabIndex={hasFile ? 0 : -1} aria-label={hasFile ? 'Spreadsheet data table, scroll horizontally for more columns' : 'File import'}>
              {importing ? <TableSkeleton /> : <>{hasFile && <table className="sheet-table"><caption className="sr-only">Spreadsheet data. Click a cell to edit its value.</caption><thead><tr><th scope="col" className="row-number">#</th>{data.headers.map((header, col) => <th scope="col" key={header} className={['price', 'stock'].includes(report.kinds[col] ?? '') ? 'numeric' : undefined}><span className="column-letter" aria-hidden="true">{columnLetter(col)}</span><span className="column-name" title={header}>{header}</span><span className="column-kind" aria-hidden="true">{['price', 'stock'].includes(report.kinds[col] ?? '') ? '#' : 'Aa'}</span></th>)}<th scope="col" className="status-column">Review</th></tr></thead>
                <tbody>{displayedRows.map(row => {
                  const issues = report.issues.get(row.id) ?? [];
                  return <tr key={row.id} className={issueRow === row.id ? 'reviewed-row' : undefined}><th scope="row" className="row-number">{row.id}</th>{row.cells.map((value, col) => {
                    const cellIssues = issues.filter(issue => issue.col === col);
                    const change = changes.get(`${row.id}:${col}`);
                    const label = `Row ${row.id}, ${data.headers[col]}`;
                    const numeric = ['price', 'stock'].includes(report.kinds[col] ?? '');
                    return <td key={col}>{editing?.rowId === row.id && editing.col === col ? <CellEditor key={`${row.id}:${col}`} value={value} label={label} onSave={(draft, restoreFocus) => { editCell(row, col, draft); if (restoreFocus) focusCell(row.id, col); }} onCancel={() => { setEditing(null); focusCell(row.id, col); }} /> :
                      <div className="cell-content"><button data-cell={`${row.id}:${col}`} className={`cell-button${report.kinds[col] === 'sku' ? ' mono' : ''}${numeric ? ' numeric' : ''}${cellIssues.length ? ' has-issue' : ''}${change ? ' changed' : ''}`} aria-label={`Edit row ${row.id}, ${data.headers[col]}: ${value || 'empty'}`} aria-disabled={!!state.stage}
                        title={change ? `Before: ${change.before || '(empty)'}\nAfter: ${value || '(empty)'}` : cellIssues.map(issue => issue.message).join('\n') || value}
                        onClick={() => state.stage ? notify('Apply or discard the preview before editing cells.', 'info', 'edit') : setEditing({ rowId: row.id, col })}>{value || <span className="empty-cell">Empty</span>}</button>{row.formulas?.[col] && <button className="formula-button" aria-label={`Inspect formula in row ${row.id}, ${data.headers[col]}`} title="Inspect original Excel formula" onClick={() => { setFormulaTarget({ rowId: row.id, col }); openModal('formula'); }}>fx</button>}</div>}</td>;
                  })}<td className="status-cell">{issues.length ? <button className="status-tag warning" data-review={row.id} aria-label={`Review ${issues.length} issues in row ${row.id}`} aria-pressed={issueRow === row.id} onClick={() => { setIssueRow(row.id); requestAnimationFrame(() => document.getElementById('row-review-heading')?.focus()); }}><AlertTriangle aria-hidden="true" />{issues.length} {issues.length === 1 ? 'issue' : 'issues'}</button> : <span className={`status-tag${changedRows.has(row.id) && preview ? ' changed-tag' : ''}`}><Check aria-hidden="true" />{changedRows.has(row.id) && preview ? 'Changed' : 'Ready'}</span>}</td></tr>;
                })}</tbody>
              </table>}
              {!hasFile && <div className="empty-state import-empty-state"><FileSpreadsheet aria-hidden="true" /><h2>Open a spreadsheet</h2><p>Drop a CSV, TSV, or Excel file here, or choose one from your device.</p><ActionButton onClick={() => fileInput.current?.click()}><FolderOpen aria-hidden="true" />Choose file</ActionButton><small>Up to 5 MB · Your file stays on this device</small></div>}
              {hasFile && !filteredRows.length && <div className="empty-state"><Search aria-hidden="true" /><h2>No matching rows</h2><p>Change your search or filter to see more rows.</p><ActionButton secondary onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</ActionButton></div>}</>}
            </div>
            <div className="table-footer"><span className="row-range">{importing ? 'Reading file…' : filteredRows.length ? `Showing ${start + 1}–${Math.min(start + pageSize, filteredRows.length)} of ${filteredRows.length.toLocaleString()} rows` : hasFile ? '0 matching rows' : 'No file loaded'}</span><div className="page-size"><span>Rows per page</span><Dropdown className="page-size-select" aria-label="Rows per page" disabled={!hasFile} value={String(pageSize)} onValueChange={value => { setPageSize(Number(value)); setPage(1); }} options={[10, 25, 50, 100].map(size => ({ value: String(size), label: String(size) }))} /></div><div className="pagination"><button className="icon-button" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft aria-hidden="true" /></button><span>{currentPage} / {pageCount}</span><button className="icon-button" aria-label="Next page" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight aria-hidden="true" /></button></div></div>
          </section>
          <aside className="inspector" aria-label="Cleaning and review tools" id="cleaning-tools" tabIndex={-1}>
            <div className="inspector-heading"><h2>Cleaning steps</h2><span>{hasFile ? `${operations.length} selected` : 'No file loaded'}</span></div>
            <div className="inspector-section">
              <div className="preset-label"><span>Preset</span><Dropdown aria-label="Cleaning preset" disabled={!hasFile} value={selectedPreset?.id ?? 'custom'} onValueChange={value => { const recipe = catalog.recipes.find(item => item.id === value); if (recipe) { setAnalysisProfile(recipe.profile); setSelected(recipe.operations); setFilter('all'); clearStage(); } }} options={[
                { value: 'custom', label: 'Custom recipe', disabled: true },
                ...catalog.recipes.map(recipe => ({ value: recipe.id, label: recipe.name })),
              ]} /></div>
              <p className="profile-note">{analysisProfile === 'general' ? 'General checks: extra spaces, exact duplicates, and empty cells.' : 'Inventory checks: SKUs, categories, prices, and stock, plus spaces and duplicates.'}</p>
              <div className="recipes">{visibleOperations.map(recipe => <div className="recipe-block" key={recipe.id}><label className={`recipe${!available(recipe.id) ? ' unavailable' : ''}`} title={!hasFile ? 'Open a spreadsheet first.' : available(recipe.id) ? undefined : `No recognized ${recipe.id} column in this file.`}><input type="checkbox" checked={operations.includes(recipe.id)} disabled={!available(recipe.id)} onChange={event => { setSelected(event.target.checked ? [...selected, recipe.id] : selected.filter(id => id !== recipe.id)); clearStage(); }} /><span><strong>{recipe.title}</strong><small>{recipe.description}</small></span></label>{operations.includes(recipe.id) && isConfigurableOperation(recipe.id) && <CleaningOptions id={recipe.id} title={recipe.title} headers={state.data.headers} options={cleanupOptions} onChange={next => { setCleanupOptions(next); clearStage(); }} />}</div>)}</div>
              <div className="inspector-run">{optionsError && <p className="step-validation" role="status">{optionsError}</p>}<ActionButton className="full-width" aria-label="Preview fixes" disabled={!operations.length || !!optionsError || state.busy} onClick={previewFixes}><ScanLine aria-hidden="true" />{state.busy && loading?.kind === 'preview' ? 'Preparing preview…' : 'Preview fixes'}</ActionButton><p className="recipe-hint">{hasFile ? 'Changes are applied after you review them.' : 'Open a file to choose cleaning steps.'}</p>{operations.some(isConfigurableOperation) && <p className="step-order">Order: trim → spaces → casing → replace → inventory formatting → duplicates.</p>}</div>
            </div>
            <section className="review-summary inspector-section"><h3>Review</h3>{importing ? <ReviewSkeleton /> : <div className="review-totals"><button disabled={!hasFile} onClick={() => { setFilter('issues'); document.getElementById('workspace')?.focus(); }}><i aria-hidden="true" />{report.needsAttention} rows need attention<ArrowUpRight aria-hidden="true" /></button><span>{report.ready} rows pass the current checks</span></div>}</section>
            <section className="issue-details inspector-section" aria-label="Row review" aria-live="polite">
              {importing ? <ReviewSkeleton /> : currentIssues.length > 0 ? <><div className="issue-heading"><h3 id="row-review-heading" tabIndex={-1}>Row {issueRow}</h3><button className="icon-button" aria-label="Close row details" onClick={() => { const id = issueRow; setIssueRow(null); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-review="${id}"]`)?.focus()); }}><X aria-hidden="true" /></button></div><ol className="issue-list">{currentIssues.map((issue, index) => <li key={index}><span className="issue-column">{data.headers[issue.col] ?? 'Row'}</span><p className="issue-message">{issue.message}</p></li>)}</ol></> : <div className="issue-placeholder"><MousePointer2 aria-hidden="true" /><p>{hasFile ? 'Select a row’s issue count to see what needs attention.' : 'Row issues will appear here after you open a file.'}</p></div>}
            </section>
            {state.source.notes.length > 0 && <details className="import-notes"><summary>Excel import notes</summary><ul>{state.source.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
            <div className="file-limits"><span>CSV, TSV, XLSX · up to 5 MB</span><span>20,000 rows · 100 columns</span></div>
          </aside>
        </div>
      </main>
      <footer className="app-statusbar"><div className="status-left"><span className="status-dot" aria-hidden="true" />Files stay on this device<span className="status-divider" aria-hidden="true">·</span><span className="session-note">Export before closing</span></div><div className="status-right">{state.busy && loading ? loading.label : !hasFile ? 'Ready to open a file' : state.stage ? 'Preview — not applied' : editing ? 'Enter to save · Esc to cancel' : 'Click a cell to edit'}<span className="status-divider" aria-hidden="true">·</span><span>UTF-8</span></div></footer>
      {dragging && <div className="drag-overlay" aria-hidden="true"><FolderOpen /><strong>Drop a file to open it</strong><span>CSV, TSV, or Excel (.xlsx)</span></div>}
    </div>
    <Dialog open={modal !== null} onOpenChange={open => { if (!open && !state.busy) { setModal(null); confirmAction.current = null; setPendingWorkbook(null); } }}>
      <DialogContent className={`modal-content${modal === 'removed' ? ' removed-modal' : ''}`} showCloseButton={!state.busy} aria-busy={state.busy} onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => { if (dialogReturnFocus.current?.isConnected) dialogReturnFocus.current.focus(); else document.querySelector<HTMLButtonElement>('[aria-label="Open spreadsheet file"]')?.focus(); }); }} onEscapeKeyDown={event => { if (state.busy) event.preventDefault(); }} onPointerDownOutside={event => { if (state.busy || event.target instanceof Element && event.target.closest('[data-toast-viewport]')) event.preventDefault(); }}>
        {modal === 'help' && <ModalBody title="RowReady help" description="Import a table, review changes, and export your data."><ol className="guide"><li><strong>Open a file</strong><p>Import a UTF-8 CSV or TSV, or choose a worksheet from an Excel (.xlsx) file. Use a simple table with a header row. Up to 5 MB, 20,000 rows, and 100 columns. Excel uses displayed values, including saved formula results. Recalculate and save in Excel first. Unmerge merged cells before import.</p></li><li><strong>Choose cleaning steps</strong><p>General cleanup trims cell edges and removes exact duplicates. Optional steps normalize repeated spaces, change casing, find and replace exact text, or match duplicates using selected columns. Choose columns for each optional step. Empty cells are flagged for review and may be intentional. Choose Inventory cleanup to enable SKU, category, price, and stock checks. Dates, numbers, codes, and letter casing stay as written unless you select a step that changes them.</p></li><li><strong>Preview and edit</strong><p>Compare Current and Preview and review rows marked for removal, then apply. Click any cell to edit its text value. Select fx to inspect the original formula and saved result; formulas do not recalculate after edits. Enter saves, Shift+Enter adds a line, and Escape cancels.</p></li><li><strong>Export your results</strong><p>Download your data as CSV or a new Excel workbook, or export a PDF cleanup report. Undo the last 20 edits or reset to the original file. Refreshing closes the workspace, so download before leaving.</p></li></ol><p className="modal-note">Inventory price cleanup uses a decimal point and comma thousands separators; it does not convert currencies. General cleanup leaves numeric and date formatting unchanged. Only operation IDs and the recipe version reach the API; your columns, find/replace text, and file stay in this browser.</p><a className="license-link" href="/licenses.txt" target="_blank" rel="noreferrer">Open-source notices ↗</a><ActionButton onClick={() => setModal(null)}>Got it</ActionButton></ModalBody>}
        {modal === 'formula' && formulaTarget && formulaCell && <ModalBody title="Formula details" description={`Source: ${state.source.worksheet ?? 'Worksheet'}!${formulaCell.address} · Row ${formulaTarget.rowId}, ${data.headers[formulaTarget.col]}`}>
          <dl className="formula-details"><div><dt>Original formula</dt><dd><code>={formulaCell.formula}</code></dd></div>{formulaCell.range && <div><dt>Formula range</dt><dd>{formulaCell.range}</dd></div>}<div><dt>Saved result</dt><dd>{formulaCell.savedValue || '(empty)'}</dd></div><div><dt>Current value{state.stage && preview ? ' (preview)' : ''}</dt><dd>{formulaRow?.cells[formulaTarget.col] || '(empty)'}</dd></div></dl>
          <p className="modal-note">This formula is shown for reference. Its saved result may be outdated. Edits and cleaning change the text value only; this cell and other formulas will not recalculate. Exports contain values only.</p>
          <ActionButton onClick={() => setModal(null)}>Done</ActionButton>
        </ModalBody>}
        {modal === 'removed' && state.stage && <ModalBody title="Rows to remove" description={`${state.stage.removed.length} ${state.stage.removed.length === 1 ? 'row' : 'rows'} marked for removal. Nothing is removed until you apply the preview.`}>
          <p className="modal-note">These are the original values before this cleanup. The first matching row is kept. {state.stageOperations.includes('duplicatesByKey') ? `Selected matching columns: ${cleanupOptions.duplicatesByKey.columns.map(col => state.data.headers[col]).join(', ')}. Rows with a blank key are kept by this step. Exact duplicates may also be removed if that step is enabled.` : 'Every column must match after cleaning.'}</p>
          <div className="removed-table-scroll" tabIndex={0} aria-label="Rows marked for removal"><table className="removed-table"><thead><tr><th scope="col">Row</th>{state.data.headers.map((header, col) => <th scope="col" key={col}>{header}</th>)}</tr></thead><tbody>{state.stage.removed.slice((removedPage - 1) * 50, removedPage * 50).map(row => <tr key={row.id}><th scope="row">{row.id}</th>{row.cells.map((value, col) => <td key={col}>{value || <span className="empty-cell">Empty</span>}</td>)}</tr>)}</tbody></table></div>
          <div className="removed-pagination"><span>Page {removedPage} of {Math.ceil(state.stage.removed.length / 50)}</span><button className="icon-button" aria-label="Previous removed rows" disabled={removedPage <= 1} onClick={() => setRemovedPage(removedPage - 1)}><ChevronLeft aria-hidden="true" /></button><button className="icon-button" aria-label="Next removed rows" disabled={removedPage * 50 >= state.stage.removed.length} onClick={() => setRemovedPage(removedPage + 1)}><ChevronRight aria-hidden="true" /></button></div>
          <ActionButton onClick={() => setModal(null)}>Back to preview</ActionButton>
        </ModalBody>}
        {modal === 'confirm' && <ModalBody title="Replace this workspace?" description="Your current edits and preview will be lost. Export first if you want to keep them."><div className="modal-actions"><ActionButton secondary onClick={() => { setModal(null); confirmAction.current = null; }}>Cancel</ActionButton><ActionButton onClick={() => { const action = confirmAction.current; confirmAction.current = null; setModal(null); action?.(); }}>Continue</ActionButton></div></ModalBody>}
        {modal === 'worksheet' && pendingWorkbook && <ModalBody title="Choose a worksheet" description={`Import one table from ${pendingWorkbook.file.name}. Your current workspace stays intact until the import succeeds.`}>
          <div className="format-field"><span>Worksheet</span><Dropdown aria-label="Worksheet" value={worksheet} disabled={state.busy} onValueChange={value => { setWorksheet(value); setWorksheetError(''); }} options={pendingWorkbook.sheets.map(sheet => ({ value: sheet.name, label: `${sheet.name}${sheet.hidden ? ' (hidden)' : ''}`, disabled: sheet.hidden }))} /></div>
          {importing ? <div className="worksheet-progress" role="status"><Spinner /><div><strong>Reading your worksheet…</strong><p>Preparing the table and checking its values.</p></div></div> : <p className="modal-note">The first nonempty row becomes the header. Empty rows are skipped. Displayed values, including formatted dates and codes, become text. Formulas use their last saved results, which may be outdated. Recalculate and save in Excel first. Formulas will not recalculate here. Use plain-text headers and unmerge cells. Hidden sheets stay excluded.</p>}
          {worksheetError && <p className="message error-message" role="alert">{worksheetError}</p>}
          <div className="modal-actions"><ActionButton secondary disabled={state.busy} onClick={() => { setModal(null); setPendingWorkbook(null); setError(''); }}>Cancel</ActionButton><ActionButton aria-label="Import worksheet" disabled={state.busy || !worksheet} onClick={() => { void importSelectedWorksheet(); }}>{state.busy ? 'Reading worksheet…' : 'Import worksheet'}</ActionButton></div>
        </ModalBody>}
        {modal === 'export' && <ModalBody title="Export your data" description={`${state.data.rows.length.toLocaleString()} rows · ${report.needsAttention} rows need review. Export uses your current applied data and ${analysisProfile === 'inventory' ? 'inventory' : 'general'} checks.`}>
          <div className="format-field"><span>Download format</span><Dropdown aria-label="Download format" value={exportFormat} onValueChange={value => setExportFormat(value as ExportFormat)} options={[
            { value: 'csv', label: 'CSV — spreadsheet data' },
            { value: 'xlsx', label: 'Excel (.xlsx) — spreadsheet data' },
            { value: 'pdf', label: 'PDF — cleanup report' },
          ]} /></div>
          {exportFormat === 'csv' && <><label className="export-option"><input type="checkbox" checked={safeExport} onChange={event => setSafeExport(event.target.checked)} /><span><strong>Protect spreadsheet formulas</strong><small>Prefix formula-like values with an apostrophe so spreadsheet apps read them as text.</small></span></label><p className="modal-note">CSV preserves your columns and uses UTF-8 encoding. Flagged values are included unchanged.</p></>}
          {exportFormat === 'xlsx' && <p className="modal-note">Creates a new workbook with one worksheet of text values, preserving codes and leading zeros. Your original workbook stays untouched. Formulas are not preserved or recalculated. Flagged values are included unchanged.</p>}
          {exportFormat === 'pdf' && <p className="modal-note">A shareable summary of before-and-after quality, applied cleaning steps, manual edits, and remaining issues. Includes up to 100 review findings with row IDs. Download CSV or Excel for the complete spreadsheet.</p>}
          {formulaCount > 0 && exportFormat === 'csv' && <p className="modal-note">Formula cells export their current values. Original formulas are not preserved or recalculated.</p>}
          <ActionButton className="full-width" onClick={download}><ArrowDownToLine />Download {exportFormat === 'xlsx' ? 'Excel' : exportFormat.toUpperCase()}</ActionButton>
        </ModalBody>}
      </DialogContent>
    </Dialog>
    <Toaster toasts={toasts} onDismiss={dismiss} />
    {state.busy && loading && (importing ? <div className="sr-only" role="status" aria-live="polite">{loading.label} {loading.filename}</div> : <div className="task-progress" role="status" aria-live="polite"><Spinner /><div><strong>{loading.label}</strong><p>File processing stays on this device.</p></div></div>)}
  </>;
}
