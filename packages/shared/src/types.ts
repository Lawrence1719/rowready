export const OPERATION_IDS = ['trim', 'whitespace', 'case', 'replace', 'sku', 'category', 'price', 'duplicates', 'duplicatesByKey'] as const;
export type OperationId = (typeof OPERATION_IDS)[number];
export type Delimiter = ',' | ';' | '\t';
export type AnalysisProfile = 'general' | 'inventory';
export type ColumnKind = 'sku' | 'category' | 'price' | 'stock' | 'text';
export interface FormulaCell { formula: string; address: string; savedValue: string; range?: string }
export interface CsvRow { id: number; cells: string[]; formulas?: Record<number, FormulaCell> }
export interface CsvDataset { headers: string[]; rows: CsvRow[]; delimiter: Delimiter }
export interface CellIssue { col: number; code: string; message: string }
export interface Analysis { issues: Map<number, CellIssue[]>; total: number; needsAttention: number; ready: number; kinds: ColumnKind[] }
export interface CellChange { rowId: number; col: number; before: string; after: string }
export interface CleanupResult { data: CsvDataset; changes: CellChange[]; removed: CsvRow[] }
export interface CleanupOptions {
  whitespace?: { columns: number[] };
  case?: { columns: number[]; mode: 'lower' | 'upper' | 'title' };
  replace?: { columns: number[]; find: string; replacement: string };
  duplicatesByKey?: { columns: number[] };
}
export interface OperationDefinition { id: OperationId; title: string; description: string }
export interface RecipePreset { id: string; name: string; description: string; version: 1; profile: AnalysisProfile; operations: OperationId[] }
export interface RecipeConfiguration { version: 1; operations: OperationId[] }
export interface RecipeCatalog { version: 1; recipes: RecipePreset[]; operations: OperationDefinition[] }
export interface RecipeValidation { valid: true; recipe: RecipeConfiguration }
