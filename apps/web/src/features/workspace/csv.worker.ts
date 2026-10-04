import { parseCSV, cleanData, serializeCSV } from '@rowready/shared';
import type { WorkerRequest } from './worker-client';

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    switch (data.type) {
      case 'parse': {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(data.buffer); }
        catch { throw new Error('This file is not UTF-8. Export it as UTF-8 CSV and try again.'); }
        self.postMessage({ result: parseCSV(text) }); break;
      }
      case 'inspect-xlsx': {
        const { inspectWorkbook } = await import('./excel');
        self.postMessage({ result: inspectWorkbook(data.buffer) }); break;
      }
      case 'parse-xlsx': {
        const { importWorksheet } = await import('./excel');
        self.postMessage({ result: importWorksheet(data.buffer, data.sheetName) }); break;
      }
      case 'clean': self.postMessage({ result: cleanData(data.data, data.operations, data.options) }); break;
      case 'export': self.postMessage({ result: serializeCSV(data.data, data.safe).text }); break;
      case 'export-xlsx': {
        const { exportWorkbook } = await import('./excel');
        const result = exportWorkbook(data.data);
        self.postMessage({ result }, { transfer: [result] }); break;
      }
      case 'export-pdf': {
        const { createCleanupReport } = await import('../exports/report');
        const result = await createCleanupReport(data.report);
        self.postMessage({ result }, { transfer: [result] }); break;
      }
    }
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Unable to process this file.' }); }
};
