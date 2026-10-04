import { SAMPLE_CSV, RECIPES, parseCSV, analyze, cleanData, serializeCSV, columnKinds } from './data.js';
import { fillIcons, icon } from './icons.js';
const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const state = { data: parseCSV(SAMPLE_CSV), original: null, filename: 'sample-inventory.csv', sample: true, history: [], stage: null, preview: true, page: 1, search: '', filter: 'all', dirty: false, busy: false };
state.original = state.data;
let currentReport, currentRows = [], toastTimer, searchTimer;
const PAGE_SIZE = 10;
fillIcons();
$('recipes').innerHTML = RECIPES.map(r => `<label class="recipe"><input type="checkbox" value="${r.id}" checked><span><strong>${r.title}</strong><small>${r.description}</small></span></label>`).join('');
function selectedRecipes() { return [...$('recipes').querySelectorAll('input:checked')].map(input => input.value); }
function notify(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
function showError(error) { $('error-box').textContent = error instanceof Error ? error.message : String(error); $('error-box').hidden = false; }
function clearError() { $('error-box').hidden = true; $('error-box').textContent = ''; }
function pushHistory() { state.history.push(state.data); if (state.history.length > 20) state.history.shift(); }
function displayedData() { return state.stage && state.preview ? state.stage.data : state.data; }
function clearStage() { state.stage = null; state.preview = true; if (state.filter === 'changed') { state.filter = 'all'; $('filter-select').value = 'all'; } }
function updateRecipeAvailability() {
  const kinds = columnKinds(state.data.headers);
  $('recipes').querySelectorAll('input').forEach(input => {
    const available = ['trim', 'duplicates'].includes(input.value) || kinds.includes(input.value);
    input.disabled = !available;
    input.closest('label').classList.toggle('unavailable', !available);
    if (!available) input.checked = false;
    input.closest('label').title = available ? '' : `No recognized ${input.value} column in this file.`;
  });
  $('selected-count').textContent = selectedRecipes().length;
  $('preview-button').disabled = selectedRecipes().length === 0 || state.busy;
}
function render() {
  const data = displayedData();
  currentReport = analyze(data);
  const { total, needsAttention, ready } = currentReport;
  $('filename').textContent = state.filename;
  $('filemeta').textContent = `${state.data.delimiter === '\t' ? 'TSV' : 'CSV'} · ${data.headers.length} columns · ${state.dirty ? 'Edited' : 'Original file'}`;
  $('sample-badge').hidden = !state.sample;
  $('stat-total').textContent = total.toLocaleString();
  $('stat-issues').textContent = needsAttention.toLocaleString();
  $('stat-ready').textContent = total ? Math.round(ready / total * 100) : '0';
  $('stat-columns').textContent = `${data.headers.length} columns in your file`;
  $('stat-issue-note').textContent = needsAttention ? `${needsAttention === 1 ? 'One row needs' : 'Rows need'} a closer look` : 'Everything looks consistent';
  $('health-progress').style.width = `${total ? ready / total * 100 : 0}%`;
  $('row-count').textContent = total.toLocaleString();
  $('undo-button').disabled = !state.history.length || state.busy;
  $('reset-button').disabled = !state.dirty && !state.stage;
  $('export-button').disabled = !!state.stage || state.busy;
  $('export-button').title = state.stage ? 'Apply or discard your preview before exporting.' : 'Export the current inventory';
  $('preview-banner').hidden = !state.stage;
  $('view-switch').hidden = !state.stage;
  $('filter-select').querySelector('option[value="changed"]').disabled = !state.stage;
  if (state.stage) {
    const { changes, removed } = state.stage;
    $('preview-summary').textContent = `${changes.length} cell${changes.length === 1 ? '' : 's'} changed · ${removed.length} duplicate${removed.length === 1 ? '' : 's'} removed`;
    const pending = analyze(state.stage.data).needsAttention;
    $('preview-detail').textContent = pending ? `${pending} row${pending === 1 ? '' : 's'} will still need manual review.` : 'All rows will be ready to go.';
    $('current-view').classList.toggle('active', !state.preview);
    $('preview-view').classList.toggle('active', state.preview);
    $('current-view').setAttribute('aria-pressed', String(!state.preview));
    $('preview-view').setAttribute('aria-pressed', String(state.preview));
  }
  $('table-hint').textContent = state.stage ? 'Compare the changes. Apply or discard to continue editing.' : 'Click a cell to edit. Flagged cells need a closer look.';
  $('bottom-note').textContent = state.stage ? 'Preview only. Your current inventory has not changed.' : needsAttention ? 'Missing values and conflicting SKUs are left for you to review.' : 'Your inventory looks consistent. Review it once more, then export.';
  $('issue-details').hidden = true;
  updateRecipeAvailability();
  renderTable();
}
function renderTable() {
  const data = displayedData(), report = currentReport;
  const changedRows = new Set(state.stage?.changes.map(x => x.rowId) || []);
  const changes = new Map((state.stage && state.preview ? state.stage.changes : []).map(x => [`${x.rowId}:${x.col}`, x]));
  const query = state.search.toLocaleLowerCase();
  currentRows = data.rows.filter(row => {
    if (state.filter === 'issues' && !report.issues.has(row.id)) return false;
    if (state.filter === 'ready' && report.issues.has(row.id)) return false;
    if (state.filter === 'changed' && !changedRows.has(row.id)) return false;
    return !query || row.cells.some(v => v.toLocaleLowerCase().includes(query));
  });
  const pageCount = Math.max(1, Math.ceil(currentRows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pageCount);
  const start = (state.page - 1) * PAGE_SIZE, rows = currentRows.slice(start, start + PAGE_SIZE);
  $('data-table').querySelector('thead').innerHTML = '<tr><th scope="col" class="row-number">#</th>' + data.headers.map(h => `<th scope="col">${escape(h)}</th>`).join('') + '<th scope="col">Status</th></tr>';
  $('data-table').querySelector('tbody').innerHTML = rows.map(row => {
    const issues = report.issues.get(row.id) || [];
    const cells = row.cells.map((value, col) => {
      const cellIssues = issues.filter(i => i.col === col), changed = changes.get(`${row.id}:${col}`);
      const title = changed ? `Before: ${changed.before || '(empty)'}\nAfter: ${value || '(empty)'}` : cellIssues.map(i => i.message).join('\n') || value;
      return `<td><button class="cell-button${col === 0 ? ' mono' : ''}${cellIssues.length ? ' has-issue' : ''}${changed ? ' changed' : ''}" data-row="${row.id}" data-col="${col}" title="${escape(title)}" aria-label="Edit row ${row.id}, ${escape(data.headers[col])}: ${escape(value || 'empty')}" ${state.stage ? 'aria-disabled="true"' : ''}>${value ? escape(value) : '<span class="empty-cell">Empty</span>'}</button></td>`;
    }).join('');
    return `<tr><th scope="row" class="row-number">${row.id}</th>${cells}<td class="status-cell">${issues.length ? `<button class="status-tag warning" data-issues="${row.id}" aria-label="Review ${issues.length} issues in row ${row.id}">${icon('alert')}Review · ${issues.length}</button>` : `<span class="status-tag${changedRows.has(row.id) && state.preview ? ' changed-tag' : ''}">${icon('check')}${changedRows.has(row.id) && state.preview ? 'Cleaned' : 'Ready'}</span>`}</td></tr>`;
  }).join('');
  $('empty-state').hidden = currentRows.length !== 0;
  $('pagination-label').textContent = currentRows.length ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, currentRows.length)} of ${currentRows.length.toLocaleString()} rows` : '0 matching rows';
  $('page-label').textContent = `${state.page} / ${pageCount}`;
  $('prev-page').disabled = state.page <= 1;
  $('next-page').disabled = state.page >= pageCount;
}
function previewFixes() {
  clearError();
  const selected = selectedRecipes();
  if (!selected.length) throw new Error('Select at least one cleaning step.');
  const result = cleanData(state.data, selected);
  if (!result.changes.length && !result.removed.length) { clearStage(); render(); notify('No changes needed for the selected steps.'); return { changedCells: 0, removedRows: 0 }; }
  state.stage = result; state.preview = true; state.page = 1; render();
  notify('Preview ready. Review the changes before applying.');
  return { changedCells: result.changes.length, removedRows: result.removed.length, remainingRowsNeedingReview: analyze(result.data).needsAttention };
}
function applyFixes() {
  if (!state.stage) throw new Error('Preview your fixes before applying them.');
  const count = state.stage.changes.length;
  pushHistory(); state.data = state.stage.data; state.dirty = true; clearStage(); render();
  notify(`Fixes applied. ${count} cells updated. You can undo this.`);
  return summary();
}
function undo() {
  if (!state.history.length) throw new Error('There is no change to undo.');
  state.data = state.history.pop(); state.dirty = state.data !== state.original; clearStage(); render(); notify('Last change undone.'); return summary();
}
function editCell(rowId, col, value) {
  if (state.stage) throw new Error('Apply or discard the preview before editing.');
  const row = state.data.rows.find(r => r.id === rowId);
  if (!row || !Number.isInteger(col) || col < 0 || col >= state.data.headers.length || typeof value !== 'string') throw new Error('Choose a valid row, column, and text value.');
  if (value.length > 100000) throw new Error('A cell can contain at most 100,000 characters.');
  if (row.cells[col] === value) return summary();
  pushHistory();
  state.data = { ...state.data, rows: state.data.rows.map(r => r.id !== rowId ? r : { ...r, cells: r.cells.map((v, c) => c === col ? value : v) }) };
  state.dirty = true; render(); return summary();
}
function beginEdit(button) {
  if (state.stage) return notify('Apply or discard the preview before editing cells.');
  const rowId = Number(button.dataset.row), col = Number(button.dataset.col), row = state.data.rows.find(r => r.id === rowId);
  const editor = document.createElement('textarea');
  editor.className = 'cell-editor'; editor.rows = Math.min(4, Math.max(1, row.cells[col].split('\n').length)); editor.value = row.cells[col];
  editor.setAttribute('aria-label', `Row ${rowId}, ${state.data.headers[col]}`);
  editor.title = 'Enter to save · Shift+Enter for a new line · Escape to cancel';
  let done = false;
  const finish = (save, refocus = false) => {
    if (done) return; done = true;
    if (save) { try { editCell(rowId, col, editor.value); } catch (e) { showError(e); } }
    renderTable();
    if (refocus) $('data-table').querySelector(`[data-row="${rowId}"][data-col="${col}"]`)?.focus();
  };
  editor.addEventListener('blur', () => finish(true));
  editor.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true, true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); } });
  button.replaceWith(editor); editor.focus(); editor.select();
}
function summary() { const r = analyze(state.data); return { filename: state.filename, rows: r.total, columns: state.data.headers, rowsNeedingReview: r.needsAttention, stagedPreview: !!state.stage, undoAvailable: !!state.history.length }; }
async function confirmAction(title, message) {
  $('confirm-title').textContent = title; $('confirm-description').textContent = message;
  const dialog = $('confirm-dialog'); dialog.showModal();
  return new Promise(resolve => {
    const finish = value => { dialog.close(); $('confirm-accept').removeEventListener('click', yes); $('confirm-cancel').removeEventListener('click', no); dialog.removeEventListener('cancel', cancel); resolve(value); };
    const yes = () => finish(true), no = () => finish(false), cancel = e => { e.preventDefault(); finish(false); };
    $('confirm-accept').addEventListener('click', yes); $('confirm-cancel').addEventListener('click', no); dialog.addEventListener('cancel', cancel);
  });
}
function setDataset(data, filename, sample = false) {
  clearTimeout(searchTimer);
  state.data = data; state.original = data; state.filename = filename; state.sample = sample; state.dirty = false; state.history = []; state.page = 1; state.search = ''; state.filter = 'all'; clearStage();
  $('search-input').value = ''; $('filter-select').value = 'all';
  $('recipes').querySelectorAll('input').forEach(input => input.checked = true);
  clearError(); render();
}
function parseFileInWorker(buffer) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch (error) { reject(new Error('This browser could not start the CSV reader. Try a recent version of Chrome, Firefox, Safari, or Edge.')); return; }
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('This file is taking too long to read. Try a smaller CSV.')); }, 20000);
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    worker.onmessage = ({ data }) => { finish(); data.error ? reject(new Error(data.error)) : resolve(data.result); };
    worker.onerror = () => { finish(); reject(new Error('The CSV reader could not finish. Check the file and try again.')); };
    worker.postMessage(buffer, [buffer]);
  });
}
async function importFile(file) {
  if (!file || state.busy) return;
  clearError();
  if (!/\.(csv|tsv)$/i.test(file.name)) return showError('Choose a .csv or .tsv file. Export Excel workbooks as CSV first.');
  if (file.size > 5 * 1024 * 1024) return showError('This file is larger than 5 MB. Split it into smaller CSVs and try again.');
  if ((state.dirty || state.stage) && !await confirmAction('Replace this inventory?', 'Your current edits will be lost. Cancel and export first if you want to keep them.')) return;
  state.busy = true; $('busy-overlay').hidden = false;
  try { const data = await parseFileInWorker(await file.arrayBuffer()); setDataset(data, file.name); notify(`${data.rows.length.toLocaleString()} rows imported. Your file stayed in this browser.`); }
  catch (error) { showError(error); }
  finally { state.busy = false; $('busy-overlay').hidden = true; render(); $('file-input').value = ''; }
}
$('preview-button').addEventListener('click', () => { try { previewFixes(); } catch (e) { showError(e); } });
$('apply-button').addEventListener('click', applyFixes);
$('discard-button').addEventListener('click', () => { clearStage(); render(); notify('Preview discarded. Your data is unchanged.'); });
$('current-view').addEventListener('click', () => { state.preview = false; render(); });
$('preview-view').addEventListener('click', () => { state.preview = true; render(); });
$('undo-button').addEventListener('click', undo);
$('reset-button').addEventListener('click', async () => { if (await confirmAction('Reset to the original file?', 'This will restore all original rows and clear your edit history.')) { state.data = state.original; state.history = []; state.dirty = false; clearStage(); render(); notify('Original file restored.'); } });
$('recipes').addEventListener('change', () => { clearStage(); render(); });
$('search-input').addEventListener('input', e => { clearTimeout(searchTimer); const value = e.target.value; searchTimer = setTimeout(() => { state.search = value; state.page = 1; renderTable(); }, 120); });
$('filter-select').addEventListener('change', e => { state.filter = e.target.value; state.page = 1; renderTable(); });
$('clear-filter').addEventListener('click', () => { clearTimeout(searchTimer); state.search = ''; state.filter = 'all'; state.page = 1; $('search-input').value = ''; $('filter-select').value = 'all'; renderTable(); });
$('prev-page').addEventListener('click', () => { state.page--; renderTable(); });
$('next-page').addEventListener('click', () => { state.page++; renderTable(); });
$('data-table').addEventListener('click', e => {
  const cell = e.target.closest('button[data-row]'); if (cell) return beginEdit(cell);
  const issueButton = e.target.closest('[data-issues]');
  if (issueButton) {
    const rowId = Number(issueButton.dataset.issues), items = currentReport.issues.get(rowId) || [];
    $('issue-details').innerHTML = `<button class="icon-button" id="close-issues" aria-label="Close row details">${icon('close')}</button><h3>Row ${rowId} · What needs attention</h3><ul>${items.map(item => `<li>${escape(item.message)}</li>`).join('')}</ul>`;
    $('issue-details').hidden = false; $('close-issues').onclick = () => $('issue-details').hidden = true;
    $('issue-details').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});
$('import-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => importFile(e.target.files[0]));
const dropZone = $('import-button');
for (const type of ['dragenter', 'dragover']) dropZone.addEventListener(type, e => { e.preventDefault(); dropZone.classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) dropZone.addEventListener(type, e => { e.preventDefault(); dropZone.classList.remove('dragging'); });
dropZone.addEventListener('drop', e => { if (e.dataTransfer.files.length > 1) return showError('Import one inventory file at a time.'); importFile(e.dataTransfer.files[0]); });
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
$('sample-button').addEventListener('click', async () => { if ((state.dirty || state.stage) && !await confirmAction('Load the sample inventory?', 'Your current edits will be replaced with sample data.')) return; setDataset(parseCSV(SAMPLE_CSV), 'sample-inventory.csv', true); notify('Sample inventory loaded. Try previewing the fixes.'); });
document.querySelectorAll('.help-trigger').forEach(b => b.addEventListener('click', () => $('help-dialog').showModal()));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
$('export-button').addEventListener('click', () => {
  const report = analyze(state.data), protectedCells = serializeCSV(state.data).protectedCells;
  $('export-summary').textContent = `${report.total} rows · ${report.needsAttention} still need review.${protectedCells ? ` Formula protection will prefix ${protectedCells} cell${protectedCells === 1 ? '' : 's'}.` : ''}`;
  $('export-dialog').showModal();
});
$('download-button').addEventListener('click', () => {
  const result = serializeCSV(state.data, $('safe-export').checked);
  const blob = new Blob(['\uFEFF', result.text], { type: 'text/csv;charset=utf-8;' }), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = state.filename.replace(/\.(csv|tsv)$/i, '') + '-cleaned.csv'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('export-dialog').close(); notify(`CSV downloaded.${result.protectedCells ? ` ${result.protectedCells} formula-like cells protected.` : ''}`);
});
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
render();
// Optional browser agent integration. Uses the same state and actions as the UI.
const context = document.modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  const register = (name, description, schema, execute, readOnlyHint = false) => {
    try { Promise.resolve(context.registerTool({ name, description, inputSchema: { type: 'object', properties: {}, additionalProperties: false, ...schema }, annotations: { readOnlyHint, untrustedContentHint: true }, execute }, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Optional API; regular controls remain available. */ }
  };
  const emptyInput = input => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('This tool takes an empty object.'); };
  register('rowready_inspect_inventory', 'Read the current inventory summary and up to 20 issues without changing data.', {}, input => { emptyInput(input); const report = analyze(state.data); return { ...summary(), issues: [...report.issues].slice(0, 20).map(([rowId, items]) => ({ rowId, issues: items })) }; }, true);
  register('rowready_preview_fixes', 'Stage a preview of selected cleaning steps. Does not change the current inventory.', {}, input => { emptyInput(input); return previewFixes(); });
  register('rowready_apply_preview', 'Apply the currently staged fixes to the inventory. Changes can be undone.', {}, input => { emptyInput(input); return applyFixes(); });
  register('rowready_undo_change', 'Undo the last applied cleanup or cell edit.', {}, input => { emptyInput(input); return undo(); });
  register('rowready_edit_cell', 'Edit one inventory cell. Column index is zero-based; use row IDs from the inventory. Preserves undo history.', { properties: { rowId: { type: 'integer' }, column: { type: 'integer', minimum: 0 }, value: { type: 'string', maxLength: 100000 } }, required: ['rowId', 'column', 'value'] }, input => {
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['rowId', 'column', 'value'].includes(k)) || !Number.isInteger(input.rowId) || !Number.isInteger(input.column) || typeof input.value !== 'string') throw new Error('Provide rowId, column, and a text value.');
    return editCell(input.rowId, input.column, input.value);
  });
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
