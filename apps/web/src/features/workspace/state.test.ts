// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cleanData, parseCSV, type CsvDataset, type OperationId } from '@rowready/shared';
import { createWorkspace, workspaceReducer, type WorkspaceAction, type WorkspaceState } from './state';

function loadedWorkspace(csv = 'sku,price\n abc ,$2.50\nABC,2.50'): WorkspaceState {
  return workspaceReducer(createWorkspace(), {
    type: 'load',
    data: parseCSV(csv),
    filename: 'inventory.csv',
  });
}

function preview(state: WorkspaceState, operations: OperationId[] = ['trim', 'sku', 'price', 'duplicates']): WorkspaceState {
  return workspaceReducer(state, {
    type: 'preview',
    result: cleanData(state.data, operations),
    operations,
  });
}

describe('workspace transactions', () => {
  it('starts empty with no file or pending transaction', () => {
    const state = createWorkspace();
    expect(state.data).toEqual({ headers: [], rows: [], delimiter: ',' });
    expect(state.original).toBe(state.data);
    expect(state).toMatchObject({ filename: '', source: { format: 'csv', notes: [] }, busy: false, history: [], historyMetadata: [], appliedOperations: [], manualEdits: 0, stage: null, stageOperations: [] });
  });

  it('loads a new dataset as the original and clears prior history, preview, and busy state', () => {
    const previous = preview(workspaceReducer(loadedWorkspace(), { type: 'edit', rowId: 1, col: 1, value: '$3.00' }));
    const data = parseCSV('sku,name\nNEW,New product');
    const next = workspaceReducer({ ...previous, busy: true }, { type: 'load', data, filename: 'new.csv' });
    expect(next).toEqual({ data, original: data, filename: 'new.csv', source: { format: 'csv', notes: [] }, history: [], historyMetadata: [], appliedOperations: [], manualEdits: 0, stage: null, stageOperations: [], busy: false });
    expect(next.original).toBe(data);
  });

  it('previews repairs and removals without changing data, original, or history', () => {
    const initial = loadedWorkspace();
    const before = JSON.stringify(initial);
    const next = preview({ ...initial, busy: true });
    expect(next.data).toBe(initial.data);
    expect(next.original).toBe(initial.original);
    expect(next.history).toBe(initial.history);
    expect(next.historyMetadata).toBe(initial.historyMetadata);
    expect(next.appliedOperations).toEqual([]);
    expect(next.stageOperations).toEqual(['trim', 'sku', 'price', 'duplicates']);
    expect(next.stage?.changes.length).toBeGreaterThan(0);
    expect(next.stage?.removed).toHaveLength(1);
    expect(next.busy).toBe(false);
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('applies a preview as one undoable transaction and restores the exact prior data on undo', () => {
    const initial = loadedWorkspace();
    const staged = preview(initial);
    const applied = workspaceReducer(staged, { type: 'apply' });
    expect(applied.data).toBe(staged.stage?.data);
    expect(applied.data.rows).toHaveLength(1);
    expect(applied.data.rows[0].cells).toEqual(['ABC', '2.50']);
    expect(applied.original).toBe(initial.original);
    expect(applied.history).toEqual([initial.data]);
    expect(applied.appliedOperations).toEqual(['trim', 'sku', 'price', 'duplicates']);
    expect(applied.manualEdits).toBe(0);
    expect(applied.historyMetadata).toEqual([{ appliedOperations: [], manualEdits: 0 }]);
    expect(applied.stage).toBeNull();
    expect(applied.stageOperations).toEqual([]);
    const undone = workspaceReducer(applied, { type: 'undo' });
    expect(undone.data).toBe(initial.data);
    expect(undone.history).toEqual([]);
    expect(undone.historyMetadata).toEqual([]);
    expect(undone.appliedOperations).toEqual([]);
    expect(undone.manualEdits).toBe(0);
    expect(undone.stage).toBeNull();
  });

  it('allows a preview containing only duplicate removals', () => {
    const initial = loadedWorkspace('sku,price\nABC,2.50\nABC,2.50');
    const staged = preview(initial);
    expect(staged.stage?.changes).toEqual([]);
    expect(staged.stage?.removed).toHaveLength(1);
    expect(workspaceReducer(staged, { type: 'apply' }).data.rows).toHaveLength(1);
  });

  it('clears a no-op preview and unlocks the workspace without adding history', () => {
    const state = loadedWorkspace('sku,price\nABC,2.50');
    const next = preview({ ...state, busy: true });
    expect(next.stage).toBeNull();
    expect(next.stageOperations).toEqual([]);
    expect(next.appliedOperations).toEqual([]);
    expect(next.busy).toBe(false);
    expect(next.data).toBe(state.data);
    expect(next.history).toEqual([]);
    expect(workspaceReducer(next, { type: 'apply' })).toBe(next);
    expect(workspaceReducer(next, { type: 'undo' })).toBe(next);
  });

  it('discards a preview without committing changes or removals', () => {
    const initial = loadedWorkspace();
    const next = workspaceReducer(preview(initial), { type: 'discard' });
    expect(next.stage).toBeNull();
    expect(next.stageOperations).toEqual([]);
    expect(next.appliedOperations).toEqual([]);
    expect(next.data).toBe(initial.data);
    expect(next.history).toEqual([]);
  });

  it('edits cells immutably and remembers manual edits for undo', () => {
    const initial = loadedWorkspace();
    const before = JSON.stringify(initial.data);
    const next = workspaceReducer(initial, { type: 'edit', rowId: 1, col: 1, value: '4.00' });
    expect(next.data.rows[0].cells[1]).toBe('4.00');
    expect(next.data).not.toBe(initial.data);
    expect(next.data.rows[0]).not.toBe(initial.data.rows[0]);
    expect(next.data.rows[1]).toBe(initial.data.rows[1]);
    expect(next.data.headers).toBe(initial.data.headers);
    expect(next.original).toBe(initial.original);
    expect(JSON.stringify(initial.data)).toBe(before);
    expect(next.history).toEqual([initial.data]);
    expect(next.manualEdits).toBe(1);
    expect(next.appliedOperations).toEqual([]);
    expect(workspaceReducer(next, { type: 'undo' }).data).toBe(initial.data);
    expect(workspaceReducer(next, { type: 'undo' }).manualEdits).toBe(0);
  });

  it('rejects manual edits while a preview is pending', () => {
    const staged = preview(loadedWorkspace());
    expect(workspaceReducer(staged, { type: 'edit', rowId: 1, col: 1, value: '9.00' })).toBe(staged);
  });

  it('ignores missing cells, oversized values, and unchanged manual edits', () => {
    const initial = loadedWorkspace();
    const invalid: WorkspaceAction[] = [
      { type: 'edit', rowId: 999, col: 0, value: 'NEW' },
      { type: 'edit', rowId: 1, col: -1, value: 'NEW' },
      { type: 'edit', rowId: 1, col: 2, value: 'NEW' },
      { type: 'edit', rowId: 1, col: 0.5, value: 'NEW' },
      { type: 'edit', rowId: 1, col: Number.NaN, value: 'NEW' },
      { type: 'edit', rowId: 1, col: 0, value: 'x'.repeat(100_001) },
      { type: 'edit', rowId: 1, col: 0, value: ' abc ' },
    ];
    for (const action of invalid) expect(workspaceReducer(initial, action)).toBe(initial);
  });

  it('reset restores the imported original and clears history and preview', () => {
    const initial = loadedWorkspace();
    const edited = workspaceReducer(initial, { type: 'edit', rowId: 1, col: 1, value: '$4.00' });
    const staged = preview(edited);
    const next = workspaceReducer(staged, { type: 'reset' });
    expect(next.data).toBe(initial.original);
    expect(next.original).toBe(initial.original);
    expect(next.history).toEqual([]);
    expect(next.historyMetadata).toEqual([]);
    expect(next.appliedOperations).toEqual([]);
    expect(next.manualEdits).toBe(0);
    expect(next.stage).toBeNull();
    expect(next.stageOperations).toEqual([]);
    expect(next.filename).toBe('inventory.csv');
  });

  it('retains the latest 20 transactions and undoes each in reverse order', () => {
    let state = loadedWorkspace('sku,price\nABC,0');
    const versions: CsvDataset[] = [state.data];
    for (let value = 1; value <= 25; value++) {
      state = workspaceReducer(state, { type: 'edit', rowId: 1, col: 1, value: String(value) });
      versions.push(state.data);
    }
    expect(state.history).toHaveLength(20);
    expect(state.historyMetadata).toHaveLength(20);
    expect(state.manualEdits).toBe(25);
    expect(state.historyMetadata.map(metadata => metadata.manualEdits)).toEqual(Array.from({ length: 20 }, (_, index) => index + 5));
    expect(state.history).toEqual(versions.slice(5, 25));
    for (let value = 24; value >= 5; value--) {
      state = workspaceReducer(state, { type: 'undo' });
      expect(state.data).toBe(versions[value]);
      expect(state.manualEdits).toBe(value);
      expect(state.historyMetadata).toHaveLength(state.history.length);
    }
    expect(state.history).toEqual([]);
    expect(state.historyMetadata).toEqual([]);
    expect(workspaceReducer(state, { type: 'undo' })).toBe(state);
  });

  it('tracks applied operations across transactions and restores report metadata with undo', () => {
    const initial = loadedWorkspace('sku,price\n abc ,$2.50');
    const trimmed = workspaceReducer(preview(initial, ['trim', 'trim']), { type: 'apply' });
    expect(trimmed.appliedOperations).toEqual(['trim']);
    const edited = workspaceReducer(trimmed, { type: 'edit', rowId: 1, col: 1, value: '$3.00' });
    const staged = preview(edited, ['trim', 'sku', 'price']);
    expect(staged.appliedOperations).toEqual(['trim']);
    expect(staged.manualEdits).toBe(1);
    const cleaned = workspaceReducer(staged, { type: 'apply' });
    expect(cleaned.appliedOperations).toEqual(['trim', 'sku', 'price']);
    expect(cleaned.manualEdits).toBe(1);
    expect(cleaned.historyMetadata).toEqual([
      { appliedOperations: [], manualEdits: 0 },
      { appliedOperations: ['trim'], manualEdits: 0 },
      { appliedOperations: ['trim'], manualEdits: 1 },
    ]);
    const undoneCleanup = workspaceReducer(cleaned, { type: 'undo' });
    expect(undoneCleanup.appliedOperations).toEqual(['trim']);
    expect(undoneCleanup.manualEdits).toBe(1);
    const undoneEdit = workspaceReducer(undoneCleanup, { type: 'undo' });
    expect(undoneEdit.appliedOperations).toEqual(['trim']);
    expect(undoneEdit.manualEdits).toBe(0);
    const undoneTrim = workspaceReducer(undoneEdit, { type: 'undo' });
    expect(undoneTrim.appliedOperations).toEqual([]);
    expect(undoneTrim.manualEdits).toBe(0);
    expect(undoneTrim.data).toBe(initial.data);
  });

  it('keeps operations already applied before the oldest retained undo transaction', () => {
    let state = workspaceReducer(preview(loadedWorkspace('sku,price\n abc ,0'), ['trim', 'sku']), { type: 'apply' });
    for (let value = 1; value <= 25; value++) {
      state = workspaceReducer(state, { type: 'edit', rowId: 1, col: 1, value: String(value) });
    }
    expect(state.historyMetadata).toHaveLength(20);
    for (let edits = 24; edits >= 5; edits--) {
      state = workspaceReducer(state, { type: 'undo' });
      expect(state.appliedOperations).toEqual(['trim', 'sku']);
      expect(state.manualEdits).toBe(edits);
      expect(state.data.rows[0].cells).toEqual(['ABC', String(edits)]);
    }
    expect(state.history).toEqual([]);
    expect(state.historyMetadata).toEqual([]);
  });

  it('clears pending operation metadata when replacing a preview with a no-op', () => {
    const staged = preview(loadedWorkspace(), ['trim']);
    const next = workspaceReducer(staged, { type: 'preview', result: cleanData(staged.data, []), operations: [] });
    expect(next.stageOperations).toEqual([]);
    expect(next.stage).toBeNull();
    expect(next.appliedOperations).toEqual([]);
  });

  it('preserves import notes and worksheet on reset while clearing all committed metadata', () => {
    const source = { format: 'xlsx' as const, worksheet: 'Inventory', notes: ['Formula cells use cached values.'] };
    const initial = workspaceReducer(createWorkspace(), { type: 'load', data: parseCSV('sku,price\n abc ,$2.50'), filename: 'inventory.xlsx', source });
    const applied = workspaceReducer(preview(initial), { type: 'apply' });
    const edited = workspaceReducer(applied, { type: 'edit', rowId: 1, col: 1, value: '7.00' });
    const reset = workspaceReducer(edited, { type: 'reset' });
    expect(reset.source).toEqual(source);
    expect(reset.data).toBe(initial.data);
    expect(reset.appliedOperations).toEqual([]);
    expect(reset.manualEdits).toBe(0);
    expect(reset.historyMetadata).toEqual([]);
    expect(reset.stageOperations).toEqual([]);
  });

  it('replaces the import source and clears committed metadata when another file loads', () => {
    const applied = workspaceReducer(preview(loadedWorkspace()), { type: 'apply' });
    const previous = workspaceReducer(applied, { type: 'edit', rowId: 1, col: 1, value: '7.00' });
    const source = { format: 'xlsx' as const, worksheet: 'Warehouse 2', notes: ['Only the selected worksheet was imported.'] };
    const next = workspaceReducer(previous, { type: 'load', data: parseCSV('sku,price\nNEW,8'), filename: 'warehouse.xlsx', source });
    expect(next.source).toEqual(source);
    expect(next.appliedOperations).toEqual([]);
    expect(next.manualEdits).toBe(0);
    expect(next.historyMetadata).toEqual([]);
    const tsv = workspaceReducer(next, { type: 'load', data: parseCSV('sku\tprice\nNEW\t9'), filename: 'inventory.TSV' });
    expect(tsv.source).toEqual({ format: 'tsv', notes: [] });
  });

  it('blocks interactive mutations during an asynchronous task', () => {
    const withHistory = workspaceReducer(loadedWorkspace(), { type: 'edit', rowId: 1, col: 1, value: '$4.00' });
    const busy = workspaceReducer(preview(withHistory), { type: 'busy', value: true });
    const actions: WorkspaceAction[] = [
      { type: 'edit', rowId: 1, col: 1, value: '9.00' },
      { type: 'apply' },
      { type: 'discard' },
      { type: 'undo' },
      { type: 'reset' },
    ];
    for (const action of actions) expect(workspaceReducer(busy, action)).toBe(busy);
    const unlocked = workspaceReducer(busy, { type: 'busy', value: false });
    expect(unlocked).toEqual({ ...busy, busy: false });
    expect(workspaceReducer(unlocked, { type: 'apply' }).stage).toBeNull();
  });
});
