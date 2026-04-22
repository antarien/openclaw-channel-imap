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
}
