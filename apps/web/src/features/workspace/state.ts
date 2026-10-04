import type { CsvDataset, CleanupResult, OperationId } from '@rowready/shared';

export interface WorkspaceSource {
  format: 'csv' | 'tsv' | 'xlsx';
  worksheet?: string;
  notes: string[];
}

interface WorkspaceMetadata {
  appliedOperations: OperationId[];
  manualEdits: number;
}

export interface WorkspaceState extends WorkspaceMetadata {
  data: CsvDataset;
  original: CsvDataset;
  filename: string;
  source: WorkspaceSource;
  history: CsvDataset[];
  historyMetadata: WorkspaceMetadata[];
  stage: CleanupResult | null;
  stageOperations: OperationId[];
  busy: boolean;
}
export type WorkspaceAction =
  | { type: 'busy'; value: boolean }
  | { type: 'load'; data: CsvDataset; filename: string; source?: WorkspaceSource }
  | { type: 'preview'; result: CleanupResult; operations?: OperationId[] }
  | { type: 'edit'; rowId: number; col: number; value: string }
  | { type: 'apply' | 'discard' | 'undo' | 'reset' };

export function createWorkspace(): WorkspaceState {
  const data: CsvDataset = { headers: [], rows: [], delimiter: ',' };
  return {
    data, original: data, filename: '',
    source: { format: 'csv', notes: [] },
    history: [], historyMetadata: [], appliedOperations: [], manualEdits: 0,
    stage: null, stageOperations: [], busy: false,
  };
}
export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  if (action.type === 'busy') return { ...state, busy: action.value };
  // Asynchronous results are the only mutations accepted during a worker task.
  if (action.type === 'load') return {
    data: action.data, original: action.data, filename: action.filename,
    source: action.source ?? { format: action.filename.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv', notes: [] },
    history: [], historyMetadata: [], appliedOperations: [], manualEdits: 0,
    stage: null, stageOperations: [], busy: false,
  };
  if (action.type === 'preview') {
    const stage = action.result.changes.length || action.result.removed.length ? action.result : null;
    return { ...state, stage, stageOperations: stage ? [...new Set(action.operations ?? [])] : [], busy: false };
  }
  if (state.busy) return state;
  const remember = () => [...state.history, state.data].slice(-20);
  // Metadata and data snapshots share the same transaction and retention limit.
  const rememberMetadata = () => [...state.historyMetadata, { appliedOperations: [...state.appliedOperations], manualEdits: state.manualEdits }].slice(-20);
  switch (action.type) {
    case 'apply': return state.stage ? {
      ...state, data: state.stage.data, history: remember(), historyMetadata: rememberMetadata(),
      appliedOperations: [...new Set([...state.appliedOperations, ...state.stageOperations])],
      stage: null, stageOperations: [],
    } : state;
    case 'discard': return { ...state, stage: null, stageOperations: [] };
    case 'undo': return state.history.length ? {
      ...state, data: state.history.at(-1)!, history: state.history.slice(0, -1),
      ...state.historyMetadata.at(-1)!, historyMetadata: state.historyMetadata.slice(0, -1),
      stage: null, stageOperations: [],
    } : state;
    case 'reset': return {
      ...state, data: state.original, history: [], historyMetadata: [],
      appliedOperations: [], manualEdits: 0, stage: null, stageOperations: [],
    };
    case 'edit': {
      const row = state.data.rows.find(r => r.id === action.rowId);
      if (state.stage || !row || !Number.isInteger(action.col) || action.col < 0 || action.col >= row.cells.length || action.value.length > 100_000 || row.cells[action.col] === action.value) return state;
      const data = { ...state.data, rows: state.data.rows.map(r => r.id !== action.rowId ? r : { ...r, cells: r.cells.map((value, col) => col === action.col ? action.value : value) }) };
      return { ...state, data, history: remember(), historyMetadata: rememberMetadata(), manualEdits: state.manualEdits + 1 };
    }
  }
}
