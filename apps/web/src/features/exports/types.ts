import type { AnalysisProfile, CsvDataset, OperationId } from '@rowready/shared';

export interface CleanupReportInput {
  filename: string;
  worksheet?: string;
  analysisProfile?: AnalysisProfile;
  original: CsvDataset;
  current: CsvDataset;
  appliedOperations: OperationId[];
  manualEdits: number;
  generatedAt: string;
  notes: string[];
}
