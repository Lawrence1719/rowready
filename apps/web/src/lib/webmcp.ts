import { useEffect, useRef } from 'react';

export interface WorkspaceToolActions {
  inspect(): unknown;
  preview(): unknown | Promise<unknown>;
  apply(): unknown;
  undo(): unknown;
  edit(rowId: number, column: number, value: string): unknown;
}

export interface WorkspaceToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    additionalProperties: false;
    required?: string[];
  };
  annotations: { readOnlyHint: boolean; untrustedContentHint: true };
  execute(input: unknown): unknown;
}

interface CompatibilityContext {
  registerTool(tool: WorkspaceToolDefinition, options: { signal: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const prototype: unknown = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function emptyInput(input: unknown): void {
  if (!isRecord(input) || Reflect.ownKeys(input).length !== 0) throw new Error('This tool takes an empty object.');
}

/** Compatibility with the optional document.modelContext host used by the legacy app. */
export function registerWorkspaceTools(context: unknown, actions: WorkspaceToolActions): () => void {
  if (typeof context !== 'object' || context === null) return () => {};
  let host: CompatibilityContext;
  try {
    if (typeof (context as Partial<CompatibilityContext>).registerTool !== 'function') return () => {};
    host = context as CompatibilityContext;
  } catch {
    return () => {};
  }

  const lifecycle = new AbortController();
  const registered = new Set<string>();
  const register = (
    name: string,
    description: string,
    execute: (input: unknown) => unknown,
    schema: Partial<WorkspaceToolDefinition['inputSchema']> = {},
    readOnlyHint = false,
  ): void => {
    const tool: WorkspaceToolDefinition = {
      name,
      description,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false, ...schema },
      annotations: { readOnlyHint, untrustedContentHint: true },
      execute(input) {
        if (lifecycle.signal.aborted) throw new Error('Workspace tools are no longer active.');
        return execute(input);
      },
    };
    try {
      const registration = host.registerTool(tool, { signal: lifecycle.signal });
      registered.add(name);
      void Promise.resolve(registration).catch(() => { registered.delete(name); });
    } catch {
      // Optional host failures must not prevent the workspace controls from working.
    }
  };
  const withoutInput = (action: () => unknown) => (input: unknown): unknown => {
    emptyInput(input);
    return action();
  };

  register('rowready_inspect_inventory', 'Read the current spreadsheet summary and up to 20 issues without changing data.', withoutInput(() => actions.inspect()), {}, true);
  register('rowready_preview_fixes', 'Stage a preview of selected cleaning steps. Does not change the current data.', withoutInput(() => actions.preview()));
  register('rowready_apply_preview', 'Apply the currently staged fixes to the data. Changes can be undone.', withoutInput(() => actions.apply()));
  register('rowready_undo_change', 'Undo the last applied cleanup or cell edit.', withoutInput(() => actions.undo()));
  register('rowready_edit_cell', 'Edit one spreadsheet cell. Column index is zero-based; use row IDs from the spreadsheet. Preserves undo history.', (input) => {
    if (!isRecord(input)
      || Reflect.ownKeys(input).length !== 3
      || !['rowId', 'column', 'value'].every((key) => Object.hasOwn(input, key))
      || !Number.isSafeInteger(input.rowId) || (input.rowId as number) < 1
      || !Number.isSafeInteger(input.column) || (input.column as number) < 0
      || typeof input.value !== 'string' || input.value.length > 100_000) {
      throw new Error('Provide a positive integer rowId, a nonnegative integer column, and a text value of at most 100,000 characters.');
    }
    return actions.edit(input.rowId as number, input.column as number, input.value);
  }, {
    properties: {
      rowId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      column: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      value: { type: 'string', maxLength: 100_000 },
    },
    required: ['rowId', 'column', 'value'],
  });

  return () => {
    if (lifecycle.signal.aborted) return;
    lifecycle.abort();
    for (const name of registered) {
      try {
        if (typeof host.unregisterTool === 'function') void Promise.resolve(host.unregisterTool(name)).catch(() => {});
      } catch {
        // Aborting also disables our callbacks when a host cannot unregister.
      }
    }
    registered.clear();
  };
}

/** Keep compatibility callbacks current while registering only for the mounted workspace. */
export function useWebMCP(actions: WorkspaceToolActions): void {
  const latest = useRef(actions);
  useEffect(() => { latest.current = actions; }, [actions]);
  useEffect(() => {
    let context: unknown;
    try {
      context = (document as Document & { modelContext?: unknown }).modelContext;
    } catch {
      return;
    }
    const cleanup = registerWorkspaceTools(context, {
      inspect: () => latest.current.inspect(),
      preview: () => latest.current.preview(),
      apply: () => latest.current.apply(),
      undo: () => latest.current.undo(),
      edit: (rowId, column, value) => latest.current.edit(rowId, column, value),
    });
    window.addEventListener('pagehide', cleanup, { once: true });
    return () => {
      window.removeEventListener('pagehide', cleanup);
      cleanup();
    };
  }, []);
}
