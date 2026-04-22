export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  debug: (m, meta) => console.debug("[imap] " + m, meta ?? ""),
  info: (m, meta) => console.info("[imap] " + m, meta ?? ""),
  warn: (m, meta) => console.warn("[imap] " + m, meta ?? ""),
  error: (m, meta) => console.error("[imap] " + m, meta ?? ""),
};
