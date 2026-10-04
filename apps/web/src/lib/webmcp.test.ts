import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceTools, useWebMCP, type WorkspaceToolActions, type WorkspaceToolDefinition } from './webmcp';

function mockHost() {
  const tools = new Map<string, WorkspaceToolDefinition>();
  const signals: AbortSignal[] = [];
  return {
    tools,
    signals,
    registerTool: vi.fn((tool: WorkspaceToolDefinition, options: { signal: AbortSignal }) => {
      tools.set(tool.name, tool);
      signals.push(options.signal);
    }),
    unregisterTool: vi.fn(),
  };
}

function mockActions(): WorkspaceToolActions {
  return { inspect: vi.fn(() => ({ total: 20 })), preview: vi.fn(async () => ({ changes: 4 })), apply: vi.fn(), undo: vi.fn(), edit: vi.fn() };
}

afterEach(() => { delete (document as Document & { modelContext?: unknown }).modelContext; });

describe('legacy browser-agent compatibility tools', () => {
  it('registers the original five names with strict schemas and delegates to workspace actions', async () => {
    const host = mockHost();
    const actions = mockActions();
    const cleanup = registerWorkspaceTools(host, actions);
    expect([...host.tools.keys()]).toEqual([
      'rowready_inspect_inventory', 'rowready_preview_fixes', 'rowready_apply_preview', 'rowready_undo_change', 'rowready_edit_cell',
    ]);
    for (const tool of host.tools.values()) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations.untrustedContentHint).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(tool.name === 'rowready_inspect_inventory');
    }
    expect(host.tools.get('rowready_inspect_inventory')!.execute({})).toEqual({ total: 20 });
    await expect(host.tools.get('rowready_preview_fixes')!.execute({})).resolves.toEqual({ changes: 4 });
    host.tools.get('rowready_apply_preview')!.execute({});
    host.tools.get('rowready_undo_change')!.execute({});
    host.tools.get('rowready_edit_cell')!.execute({ rowId: 7, column: 0, value: 'Updated SKU' });
    expect(actions.apply).toHaveBeenCalledOnce();
    expect(actions.undo).toHaveBeenCalledOnce();
    expect(actions.edit).toHaveBeenCalledWith(7, 0, 'Updated SKU');
    cleanup();
  });

  it('rejects invalid inputs before any workspace action runs', () => {
    const host = mockHost();
    const actions = mockActions();
    const cleanup = registerWorkspaceTools(host, actions);
    for (const tool of [...host.tools.values()].slice(0, 4)) {
      for (const input of [undefined, null, [], 1, '', new Date(), { extra: true }, { [Symbol('extra')]: true }]) {
        expect(() => tool.execute(input)).toThrow();
      }
    }
    const edit = host.tools.get('rowready_edit_cell')!;
    for (const input of [
      undefined, null, [], {},
      { rowId: 1, column: 0, value: 'x', extra: true },
      { rowId: 1, column: 0, value: 'x', [Symbol('extra')]: true },
      { rowId: 0, column: 0, value: 'x' },
      { rowId: 1.2, column: 0, value: 'x' },
      { rowId: Number.MAX_SAFE_INTEGER + 1, column: 0, value: 'x' },
      { rowId: 1, column: -1, value: 'x' },
      { rowId: 1, column: 0.5, value: 'x' },
      { rowId: 1, column: 0, value: 4 },
      { rowId: 1, column: 0, value: 'x'.repeat(100_001) },
      Object.assign(Object.create({ rowId: 1 }), { column: 0, value: 'x' }),
    ]) expect(() => edit.execute(input)).toThrow();
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
    cleanup();
  });

  it('aborts and unregisters on cleanup, and stale callbacks cannot run', () => {
    const host = mockHost();
    const actions = mockActions();
    const cleanup = registerWorkspaceTools(host, actions);
    expect(host.signals.every((signal) => !signal.aborted)).toBe(true);
    cleanup();
    cleanup();
    expect(host.signals.every((signal) => signal.aborted)).toBe(true);
    expect(host.unregisterTool).toHaveBeenCalledTimes(5);
    for (const name of host.tools.keys()) expect(host.unregisterTool).toHaveBeenCalledWith(name);
    expect(() => host.tools.get('rowready_apply_preview')!.execute({})).toThrow('no longer active');
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it('tolerates missing hosts and synchronous or asynchronous registration and cleanup failures', async () => {
    const actions = mockActions();
    for (const context of [undefined, null, {}, { registerTool: false }]) {
      expect(() => registerWorkspaceTools(context, actions)()).not.toThrow();
    }
    const registerTool = vi.fn().mockImplementationOnce(() => { throw new Error('Unavailable'); }).mockRejectedValueOnce(new Error('Unavailable')).mockReturnValue(undefined);
    const cleanup = registerWorkspaceTools({ registerTool, unregisterTool: () => Promise.reject(new Error('Unavailable')) }, actions);
    await Promise.resolve();
    expect(registerTool).toHaveBeenCalledTimes(5);
    expect(cleanup).not.toThrow();
    await Promise.resolve();
  });

  it('keeps React callbacks current without re-registering and cleans up on pagehide', () => {
    const host = mockHost();
    Object.defineProperty(document, 'modelContext', { value: host, configurable: true });
    const initial = mockActions();
    const replacement = mockActions();
    const { rerender, unmount } = renderHook(({ actions }) => useWebMCP(actions), { initialProps: { actions: initial } });
    expect(host.registerTool).toHaveBeenCalledTimes(5);
    rerender({ actions: replacement });
    host.tools.get('rowready_apply_preview')!.execute({});
    expect(initial.apply).not.toHaveBeenCalled();
    expect(replacement.apply).toHaveBeenCalledOnce();
    expect(host.registerTool).toHaveBeenCalledTimes(5);
    window.dispatchEvent(new Event('pagehide'));
    expect(host.signals.every((signal) => signal.aborted)).toBe(true);
    expect(host.unregisterTool).toHaveBeenCalledTimes(5);
    unmount();
    expect(host.unregisterTool).toHaveBeenCalledTimes(5);
  });
});
