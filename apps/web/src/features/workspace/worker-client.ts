import type { CsvDataset, CleanupResult, CleanupOptions, OperationId } from '@rowready/shared';
import type { WorkbookSheet } from './excel';
import type { CleanupReportInput } from '../exports/types';

export type WorkerRequest =
  | { type: 'parse'; buffer: ArrayBuffer }
  | { type: 'inspect-xlsx'; buffer: ArrayBuffer }
  | { type: 'parse-xlsx'; buffer: ArrayBuffer; sheetName: string }
  | { type: 'clean'; data: CsvDataset; operations: OperationId[]; options?: CleanupOptions }
  | { type: 'export'; data: CsvDataset; safe: boolean }
  | { type: 'export-xlsx'; data: CsvDataset }
  | { type: 'export-pdf'; report: CleanupReportInput };
type WorksheetResult = { data: CsvDataset; notes: string[] };
type WorkerResult = CsvDataset | CleanupResult | string | ArrayBuffer | WorkbookSheet[] | WorksheetResult;
export function runWorker(request: Extract<WorkerRequest, { type: 'parse' }>): Promise<CsvDataset>;
export function runWorker(request: Extract<WorkerRequest, { type: 'inspect-xlsx' }>): Promise<WorkbookSheet[]>;
export function runWorker(request: Extract<WorkerRequest, { type: 'parse-xlsx' }>): Promise<WorksheetResult>;
export function runWorker(request: Extract<WorkerRequest, { type: 'clean' }>): Promise<CleanupResult>;
export function runWorker(request: Extract<WorkerRequest, { type: 'export' }>): Promise<string>;
export function runWorker(request: Extract<WorkerRequest, { type: 'export-xlsx' | 'export-pdf' }>): Promise<ArrayBuffer>;
export function runWorker(request: WorkerRequest): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => { finish(); reject(new Error('Processing took too long. Try a smaller file.')); }, 30_000);
    worker.onmessage = ({ data }: MessageEvent<{ result?: WorkerResult; error?: string }>) => {
      finish();
      if (data.error) reject(new Error(data.error));
      else if (data.result !== undefined) resolve(data.result);
      else reject(new Error('The file could not be processed.'));
    };
    worker.onerror = () => { finish(); reject(new Error('The local file worker could not start. Refresh and try again.')); };
    worker.postMessage(request, 'buffer' in request ? [request.buffer] : []);
  });
}
