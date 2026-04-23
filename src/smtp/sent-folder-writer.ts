import { ImapFlow } from "imapflow";
import type { Logger } from "../connection/logger.js";
import { consoleLogger } from "../connection/logger.js";

export interface SentFolderWriterOptions {
  accountId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** Explicit mailbox path override. Empty/undefined → auto-detect via SPECIAL-USE \Sent. */
  sentMailbox?: string | undefined;
  logger?: Logger;
}

export interface AppendParams {
  raw: Buffer | string;
  date?: Date;
  flags?: readonly string[];
}

const SPECIAL_USE_SENT = "\\Sent";
const FALLBACK_NAMES = ["Sent", "Gesendet", "INBOX.Sent", "Sent Messages", "Sent Items"];

/**
 * Short-lived IMAP client for APPENDing outgoing mail into the account's
 * own Sent folder. Keeping this out of the long-lived IDLE connection
 * avoids interleaving an APPEND inside an IDLE session — imapflow
 * serializes commands but the extra traffic on the IDLE connection is
 * noisy and can hide genuine IDLE drops.
 *
 * Errors here never cascade to the SMTP send: the mail is already
 * delivered by the time we append, and failing to archive it locally is
 * a visibility issue, not a delivery issue. Log and move on.
 */
export class SentFolderWriter {
  private readonly opts: Required<Omit<SentFolderWriterOptions, "logger" | "sentMailbox">> & {
    logger: Logger;
    sentMailbox: string | undefined;
  };
  /** Cached path (once auto-detected) so we don't LIST on every send. */
  private cachedMailbox: string | null = null;
  /** Set after a prior run concluded there is no Sent folder to write to. */
  private knownMissing = false;

  constructor(options: SentFolderWriterOptions) {
    this.opts = {
      accountId: options.accountId,
      host: options.host,
      port: options.port,
      secure: options.secure,
      user: options.user,
      password: options.password,
      sentMailbox: options.sentMailbox,
      logger: options.logger ?? consoleLogger,
    };
  }

  async append(params: AppendParams): Promise<void> {
    if (this.knownMissing) return;

    const client = new ImapFlow({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: { user: this.opts.user, pass: this.opts.password },
      logger: false,
    });

    try {
      await client.connect();
      const mailbox = await this.resolveMailbox(client);
      if (!mailbox) {
        this.knownMissing = true;
        this.opts.logger.warn("sent-folder append skipped: no Sent mailbox found", {
          accountId: this.opts.accountId,
          explicit: this.opts.sentMailbox ?? null,
        });
        return;
      }
      const flags = [...(params.flags ?? ["\\Seen"])];
      await client.append(mailbox, params.raw, flags, params.date ?? new Date());
      this.opts.logger.info("sent-folder append ok", {
        accountId: this.opts.accountId,
        mailbox,
      });
    } catch (err) {
      this.opts.logger.warn("sent-folder append failed", {
        accountId: this.opts.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  private async resolveMailbox(client: ImapFlow): Promise<string | null> {
    if (this.cachedMailbox !== null) return this.cachedMailbox;
    if (this.opts.sentMailbox && this.opts.sentMailbox.length > 0) {
      this.cachedMailbox = this.opts.sentMailbox;
      return this.cachedMailbox;
    }
    const boxes = await client.list();
    // Prefer SPECIAL-USE \Sent — RFC 6154 — so we don't guess by name.
    for (const box of boxes) {
      const specialUse = (box as { specialUse?: string }).specialUse;
      if (specialUse === SPECIAL_USE_SENT) {
        this.cachedMailbox = box.path;
        return this.cachedMailbox;
      }
    }
    // Fallback: try common Sent-folder names in order.
    const byPath = new Set(boxes.map((b) => b.path));
    for (const name of FALLBACK_NAMES) {
      if (byPath.has(name)) {
        this.cachedMailbox = name;
        return this.cachedMailbox;
      }
    }
    return null;
  }
}
