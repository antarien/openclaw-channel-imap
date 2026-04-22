/**
 * Runtime binding. OpenClaw calls setImapRuntime(runtime) during boot.
 * Phase 1 scaffolding — the worker loop in Phase 2 will consume currentRuntime.
 */
let currentRuntime: unknown = null;

export function setImapRuntime(runtime: unknown): void {
  currentRuntime = runtime;
}

export function getImapRuntime(): unknown {
  if (!currentRuntime) {
    throw new Error("imap plugin: runtime accessed before setImapRuntime was called");
  }
  return currentRuntime;
}
