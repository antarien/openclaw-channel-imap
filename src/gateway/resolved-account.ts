import type { MaybeSecret } from "../secrets/types.js";

export interface ResolvedImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: MaybeSecret;
  mailbox: string;
}

export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: MaybeSecret;
  from: string;
}

export interface ResolvedPostProcessConfig {
  markSeen: boolean;
}

export type ReplyFormat = "text" | "markdown" | "html";

/**
 * Account shape returned by `config.resolveAccount`.
 * Mirrors the OpenClaw convention: accountId + enabled + configured flags,
 * with the provider-specific knobs nested under a well-known key.
 */
export interface ResolvedEmailAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  imap: ResolvedImapConfig;
  smtp: ResolvedSmtpConfig;
  postProcess?: ResolvedPostProcessConfig;
  /**
   * How the agent's outbound reply is formatted.
   * - "text": plain text only (text/plain MIME).
   * - "markdown": agent may use markdown; plugin converts to HTML + plain fallback (multipart/alternative).
   * - "html": same path as markdown; reserved for future HTML-only mode.
   * Default: "text".
   */
  replyFormat: ReplyFormat;
}

