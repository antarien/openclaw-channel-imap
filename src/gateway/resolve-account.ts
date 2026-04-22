import type { ResolvedEmailAccount } from "./resolved-account.js";
import { parseMaybeSecret } from "../secrets/parse.js";
import { isSecretRef, type MaybeSecret } from "../secrets/types.js";

/**
 * Parses a raw per-account config blob (from openclaw YAML) into a
 * ResolvedEmailAccount. Throws on structural problems so operators see a
 * clear error at startup instead of a mysterious runtime failure later.
 *
 * Expected shape (under `channels.imap.accounts.<accountId>`):
 *
 *   imap: { host, port, secure, user, password, mailbox? }
 *   smtp: { host, port, secure, user, password, from }
 *   enabled?: boolean (defaults to true)
 */
export function resolveEmailAccountFromConfig(
  accountId: string,
  raw: unknown,
): ResolvedEmailAccount {
  if (!isRecord(raw)) {
    throw new Error(`imap plugin: account "${accountId}" config must be an object`);
  }

  const enabled = raw.enabled === undefined ? true : raw.enabled === true;

  const imapRaw = raw.imap;
  if (!isRecord(imapRaw)) {
    throw new Error(`imap plugin: account "${accountId}" missing "imap" section`);
  }
  const imap = {
    host: requireString(imapRaw.host, `imap.host for account ${accountId}`),
    port: requirePort(imapRaw.port, `imap.port for account ${accountId}`),
    secure: imapRaw.secure === true,
    user: requireString(imapRaw.user, `imap.user for account ${accountId}`),
    password: requireMaybeSecret(imapRaw.password, `imap.password for account ${accountId}`),
    mailbox: typeof imapRaw.mailbox === "string" ? imapRaw.mailbox : "INBOX",
  };

  const smtpRaw = raw.smtp;
  if (!isRecord(smtpRaw)) {
    throw new Error(`imap plugin: account "${accountId}" missing "smtp" section`);
  }
  const smtp = {
    host: requireString(smtpRaw.host, `smtp.host for account ${accountId}`),
    port: requirePort(smtpRaw.port, `smtp.port for account ${accountId}`),
    secure: smtpRaw.secure === true,
    user: requireString(smtpRaw.user, `smtp.user for account ${accountId}`),
    password: requireMaybeSecret(smtpRaw.password, `smtp.password for account ${accountId}`),
    from: requireString(smtpRaw.from, `smtp.from for account ${accountId}`),
  };

  const configured =
    imap.host.length > 0 && imap.user.length > 0 && !isEmptyLiteral(imap.password) &&
    smtp.host.length > 0 && smtp.from.length > 0 && !isEmptyLiteral(smtp.password);

  return { accountId, enabled, configured, imap, smtp };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`imap plugin: ${what} must be a non-empty string`);
  }
  return v;
}

function requirePort(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new Error(`imap plugin: ${what} must be an integer between 1 and 65535`);
  }
  return v;
}

function requireMaybeSecret(v: unknown, what: string): MaybeSecret {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`imap plugin: ${what} must be a non-empty string (literal or "!secret <ref>")`);
  }
  return parseMaybeSecret(v);
}

function isEmptyLiteral(v: MaybeSecret): boolean {
  return !isSecretRef(v) && v.length === 0;
}
