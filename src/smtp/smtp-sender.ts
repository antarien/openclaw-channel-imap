import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "../connection/logger.js";
import { consoleLogger } from "../connection/logger.js";

export interface SmtpSenderOptions {
  accountId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** From-Address used on outgoing mail (RFC 5322 "From" header). */
  from: string;
  logger?: Logger;
}

export interface SendMailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Message-ID of the mail we're replying to, without angle brackets. */
  inReplyTo?: string;
  /** Reference-chain of the thread, without angle brackets. Oldest first. */
  references?: readonly string[];
}

const SENT_ID_MAX = 256;
const SENT_ID_TTL_MS = 15 * 60 * 1000;

/**
 * SMTP outbound sender. One long-lived nodemailer transport per account.
 * Reply-threading is built from `inReplyTo` + `references` (RFC 5322 / 2822).
 *
 * Tracks recently-sent Message-IDs so the inbound path can detect our own
 * replies landing back in the mailbox (needed when the SMTP `from` routes back
 * to the same mailbox we monitor via IMAP).
 */
export class SmtpSender {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly logger: Logger;
  private readonly accountId: string;
  private readonly sentIds = new Map<string, number>();

  constructor(opts: SmtpSenderOptions) {
    this.accountId = opts.accountId;
    this.from = opts.from;
    this.logger = opts.logger ?? consoleLogger;
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.password },
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async send(params: SendMailParams): Promise<string> {
    const inReplyTo = params.inReplyTo ? angleWrap(params.inReplyTo) : undefined;
    const references = params.references?.length
      ? params.references.map(angleWrap).join(" ")
      : undefined;

    const info = await this.transporter.sendMail({
      from: this.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      ...(params.html !== undefined ? { html: params.html } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
    });

    this.rememberSentId(info.messageId);
    this.logger.info("smtp sent", {
      accountId: this.accountId,
      to: params.to,
      messageId: info.messageId,
    });
    return info.messageId;
  }

  /**
   * Returns true iff `id` was produced by this sender within the last
   * SENT_ID_TTL_MS window. Used by the inbound path to drop our own
   * self-delivered replies before they reach `dispatchInbound`.
   */
  hasSentRecently(id: string | undefined | null): boolean {
    if (!id) return false;
    this.pruneSentIds();
    return this.sentIds.has(normalizeMessageId(id));
  }

  close(): void {
    this.transporter.close();
  }

  private rememberSentId(id: string | undefined): void {
    const key = normalizeMessageId(id);
    if (!key) return;
    this.pruneSentIds();
    this.sentIds.set(key, Date.now());
    while (this.sentIds.size > SENT_ID_MAX) {
      const oldest = this.sentIds.keys().next().value;
      if (!oldest) break;
      this.sentIds.delete(oldest);
    }
  }

  private pruneSentIds(): void {
    const cutoff = Date.now() - SENT_ID_TTL_MS;
    for (const [id, at] of this.sentIds) {
      if (at < cutoff) this.sentIds.delete(id);
    }
  }
}

function angleWrap(id: string): string {
  const s = id.trim();
  return s.startsWith("<") ? s : `<${s}>`;
}

export function normalizeMessageId(id: string | undefined | null): string {
  if (!id) return "";
  return id.trim().replace(/^<|>$/g, "").toLowerCase();
}

/**
 * Extract the bare `user@host` from a From-header value like
 * `"Name" <user@host>` or `user@host`. Returns lower-cased for comparison.
 */
export function extractBareAddress(headerValue: string): string {
  const m = /<([^>]+)>/.exec(headerValue);
  return (m?.[1] ?? headerValue).trim().toLowerCase();
}
