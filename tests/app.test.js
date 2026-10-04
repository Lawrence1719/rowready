import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Window } from 'happy-dom';
const window = new Window({ url: 'http://localhost:4173', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
const document = window.document;
document.write((await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')).replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
globalThis.window = window; globalThis.document = document;
const registered = new Map();
Object.defineProperty(document, 'modelContext', { value: { registerTool(tool) { registered.set(tool.name, tool); } } });
class BrowserWorker {
  constructor(url) { this.worker = new NodeWorker(new URL('./browser-worker-adapter.mjs', import.meta.url), { workerData: { url: url.href } }); this.worker.on('message', data => this.onmessage?.({data})); this.worker.on('error', error => this.onerror?.(error)); }
  postMessage(data, transfer) { this.worker.postMessage(data, transfer); }
  terminate() { this.worker.terminate(); }
}
globalThis.Worker = BrowserWorker;
const $ = id => document.getElementById(id);
const input = (el, value) => { el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const change = el => el.dispatchEvent(new window.Event('change', { bubbles: true }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await import('../dist/app.js');
after(() => window.happyDOM.abort());
test('inventory cleaning and editing user journeys', async t => {
  await t.test('opens with a usable sample and 10 paginated rows', () => {
    assert.equal($('stat-total').textContent, '18'); assert.equal($('data-table').querySelectorAll('tbody tr').length, 10); assert.equal($('preview-button').disabled, false);
  });
  await t.test('preview shows 17 rows without committing and can compare current data', () => {
    $('preview-button').click(); assert.equal($('stat-total').textContent, '17'); assert.equal($('export-button').disabled, true); assert.equal($('preview-banner').hidden, false);
    $('current-view').click(); assert.equal($('stat-total').textContent, '18');
    $('preview-view').click(); assert.equal($('stat-total').textContent, '17');
  });
  await t.test('apply and undo restore original rows, values, and issue counts', () => {
    $('apply-button').click(); assert.equal($('stat-total').textContent, '17'); assert.equal($('stat-issues').textContent, '2'); assert.equal($('export-button').disabled, false);
    $('undo-button').click(); assert.equal($('stat-total').textContent, '18'); assert.match(document.querySelector('[data-row="2"][data-col="0"]').textContent, /rr-1002/);
  });
  await t.test('editing a missing price updates data and can be undone', () => {
    document.querySelector('[data-row="6"][data-col="3"]').click();
    const editor = document.querySelector('.cell-editor'); input(editor, '19.25'); editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(document.querySelector('[data-row="6"][data-col="3"]').textContent, '19.25');
    $('undo-button').click(); assert.equal(document.querySelector('[data-row="6"][data-col="3"]').textContent, 'Empty');
  });
  await t.test('Escape cancels cell editing without creating a history entry', () => {
    document.querySelector('[data-row="1"][data-col="1"]').click(); const editor = document.querySelector('.cell-editor'); input(editor, 'Bad edit'); editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('[data-row="1"][data-col="1"]').textContent, 'Canvas Tote Bag'); assert.equal($('undo-button').disabled, true);
  });
  await t.test('changing recipe invalidates the old preview', () => {
    $('preview-button').click(); const checkbox = document.querySelector('#recipes input[value="trim"]'); checkbox.checked = false; change(checkbox); assert.equal($('preview-banner').hidden, true); assert.equal($('export-button').disabled, false); checkbox.checked = true; change(checkbox);
  });
  await t.test('search, empty state, clear filters, and pagination work', async () => {
    input($('search-input'), 'ceramic'); await sleep(160); assert.equal($('data-table').querySelectorAll('tbody tr').length, 1);
    input($('search-input'), 'nothing-matches-here'); await sleep(160); assert.equal($('empty-state').hidden, false);
    $('clear-filter').click(); assert.equal($('empty-state').hidden, true); $('next-page').click(); assert.equal($('page-label').textContent, '2 / 2'); assert.equal($('data-table').querySelectorAll('tbody tr').length, 8); $('prev-page').click();
  });
  await t.test('help dialog opens and closes', () => {
    document.querySelector('.help-trigger').click(); assert.equal($('help-dialog').open, true); document.querySelector('[data-close="help-dialog"]').click(); assert.equal($('help-dialog').open, false);
  });
  await t.test('export produces a real downloadable CSV', async () => {
    let exported; const create = URL.createObjectURL; URL.createObjectURL = blob => { exported = blob; return 'blob:rowready-test'; };
    const revoke = URL.revokeObjectURL; URL.revokeObjectURL = () => {};
    const anchorClick = window.HTMLAnchorElement.prototype.click; window.HTMLAnchorElement.prototype.click = () => {};
    $('export-button').click(); assert.equal($('export-dialog').open, true); $('download-button').click(); assert.ok(exported); assert.match(await exported.text(), /SKU,Product name,Category,Price,Stock/); assert.equal($('export-dialog').open, false);
    URL.createObjectURL = create; URL.revokeObjectURL = revoke; window.HTMLAnchorElement.prototype.click = anchorClick;
  });
  await t.test('actual worker imports UTF-8 TSV data', async () => {
    const file = new window.File(['sku\tprice\tstock\n001\t$12.00\t4'], 'inventory.tsv', {type:'text/tab-separated-values'});
    Object.defineProperty($('file-input'), 'files', { configurable: true, value: [file] }); change($('file-input'));
    assert.equal(document.querySelector('.app-layout').inert, true);
    assert.throws(() => registered.get('rowready_edit_cell').execute({rowId:1,column:1,value:'lost change'}), /import/);
    assert.throws(() => registered.get('rowready_preview_fixes').execute({}), /import/);
    $('sample-button').click();
    for (let i=0; i<80 && $('filename').textContent !== 'inventory.tsv'; i++) await sleep(25);
    assert.equal(document.querySelector('.app-layout').inert, false); assert.equal($('filename').textContent, 'inventory.tsv'); assert.equal($('stat-total').textContent, '1'); assert.equal(document.querySelector('[data-row="1"][data-col="0"]').textContent, '001');
  });
  await t.test('malformed imports report an error and keep the existing workspace intact', async () => {
    const file = new window.File(['sku,price\nA,"broken'], 'broken.csv'); Object.defineProperty($('file-input'), 'files', { configurable: true, value: [file] }); change($('file-input'));
    for (let i=0; i<80 && $('error-box').hidden; i++) await sleep(25);
    assert.equal($('error-box').hidden, false); assert.match($('error-box').textContent, /closing quote/); assert.equal($('filename').textContent, 'inventory.tsv');
  });
  await t.test('optional agent tools use the same UI state and reject malformed inputs', () => {
    assert.equal(registered.size, 5);
    const inspect = registered.get('rowready_inspect_inventory'), edit = registered.get('rowready_edit_cell');
    assert.equal(inspect.annotations.readOnlyHint, true); assert.equal(inspect.execute({}).rows, 1);
    assert.throws(() => edit.execute({rowId:1,column:1,value:undefined})); assert.throws(() => edit.execute({rowId:999,column:1,value:'3'}));
    edit.execute({rowId:1,column:1,value:'13.00'}); assert.equal(document.querySelector('[data-row="1"][data-col="1"]').textContent, '13.00');
    registered.get('rowready_undo_change').execute({}); assert.equal(document.querySelector('[data-row="1"][data-col="1"]').textContent, '$12.00');
    assert.throws(() => registered.get('rowready_apply_preview').execute({}), /Preview/);
  });
});
