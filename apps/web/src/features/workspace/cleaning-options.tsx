import { MAX_REPLACE_TEXT_LENGTH, type CleanupOptions } from '@rowready/shared';
import { Dropdown } from '@/components/ui/dropdown';

export type ConfigurableOperation = keyof CleanupOptions;
export function createCleanupOptions(): Required<CleanupOptions> {
  return {
    whitespace: { columns: [] },
    case: { columns: [], mode: 'lower' },
    replace: { columns: [], find: '', replacement: '' },
    duplicatesByKey: { columns: [] },
  };
}
export function isConfigurableOperation(id: string): id is ConfigurableOperation {
  return ['whitespace', 'case', 'replace', 'duplicatesByKey'].includes(id);
}

export function CleaningOptions({ id, title, headers, options, onChange }: {
  id: ConfigurableOperation;
  title: string;
  headers: string[];
  options: Required<CleanupOptions>;
  onChange: (options: Required<CleanupOptions>) => void;
}) {
  const columns = options[id].columns;
  const updateColumns = (next: number[]) => onChange({ ...options, [id]: { ...options[id], columns: next } });
  return <div className="step-options">
    <fieldset className="column-picker">
      <legend>Columns <span>{columns.length} selected</span></legend>
      <div className="column-picker-actions"><button type="button" onClick={() => updateColumns(headers.map((_, col) => col))}>Select all</button><button type="button" onClick={() => updateColumns([])}>Clear</button></div>
      <div className="column-picker-list">{headers.map((header, col) => <label key={col} title={header}><input type="checkbox" aria-label={`${title}: ${header}`} checked={columns.includes(col)} onChange={event => updateColumns(event.target.checked ? [...columns, col].sort((a, b) => a - b) : columns.filter(value => value !== col))} /><span>{header}</span></label>)}</div>
    </fieldset>
    {id === 'case' && <div className="step-field"><span>Text case</span><Dropdown aria-label="Text case" value={options.case.mode} onValueChange={mode => onChange({ ...options, case: { ...options.case, mode: mode as 'lower' | 'upper' | 'title' } })} options={[
      { value: 'lower', label: 'Lowercase' }, { value: 'upper', label: 'Uppercase' }, { value: 'title', label: 'Title case' },
    ]} /></div>}
    {id === 'replace' && <><label className="step-field"><span>Find text</span><input aria-label="Find text" value={options.replace.find} maxLength={MAX_REPLACE_TEXT_LENGTH} onChange={event => onChange({ ...options, replace: { ...options.replace, find: event.target.value } })} /></label><label className="step-field"><span>Replacement text</span><input aria-label="Replacement text" value={options.replace.replacement} maxLength={MAX_REPLACE_TEXT_LENGTH} onChange={event => onChange({ ...options, replace: { ...options.replace, replacement: event.target.value } })} /></label><p>Matches exact text, including case. Leave replacement empty to remove it.</p></>}
    {id === 'whitespace' && <p>Collapses repeated spaces. Tabs and line breaks stay unchanged.</p>}
    {id === 'case' && <p>Changes letters only. Title case also changes acronyms.</p>}
    {id === 'duplicatesByKey' && <p>Keeps the first row with matching selected values after cleaning. Rows with any blank key are kept. Review other columns before applying.</p>}
  </div>;
}
