/**
 * The preload bridge.
 *
 * This file is the entire attack surface between the renderer and the workspace.
 * It exposes three functions and no more:
 *
 *   execute(commandId, args)  run one registered command
 *   state()                   read the view model
 *   onState(handler)          subscribe to view-model pushes
 *
 * Deliberately absent: any way to read or write the database directly, any way
 * to reach Node, and any way to mutate state except by naming a command id. A
 * renderer that could call `repo.savePage` directly would make the command
 * registry decorative, and the command registry is the thing that makes the
 * application testable without a window.
 *
 * `sandbox: true` is set on the window, so this script runs in a sandboxed
 * context with a polyfilled `require`. Only `electron` is importable.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface ExecuteResult {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface Bridge {
  execute(commandId: string, args?: Record<string, unknown>): Promise<ExecuteResult>;
  state(): Promise<unknown>;
  onState(handler: (state: unknown) => void): () => void;
}

const bridge: Bridge = {
  async execute(commandId, args) {
    // Round-tripping through JSON here is not paranoia: structured clone in the
    // renderer can carry values the main process has no reason to accept, and
    // this guarantees the payload is plain data.
    return (await ipcRenderer.invoke('ow:execute', {
      id: commandId,
      args: args ? JSON.parse(JSON.stringify(args)) : {},
    })) as ExecuteResult;
  },

  async state() {
    return ipcRenderer.invoke('ow:state');
  },

  onState(handler) {
    const listener = (_event: unknown, next: unknown) => handler(next);
    ipcRenderer.on('ow:state', listener);
    return () => ipcRenderer.removeListener('ow:state', listener);
  },
};

contextBridge.exposeInMainWorld('ow', bridge);