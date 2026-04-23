import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
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

export interface SendResult {
  messageId: string;
  /** Full RFC 5322 MIME bytes of the outgoing mail, suitable for IMAP APPEND. */
  raw: Buffer;
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

  async send(params: SendMailParams): Promise<SendResult> {
    const inReplyTo = params.inReplyTo ? angleWrap(params.inReplyTo) : undefined;
    const references = params.references?.length
      ? params.references.map(angleWrap).join(" ")
      : undefined;

    // Defense-in-depth: strip CR/LF/NUL from Subject and reject `to` values
    // that contain them. Nodemailer validates envelope addresses, but
    // Subject is not header-injected in current nodemailer either — we
    // still strip here so a bug anywhere upstream cannot punch headers in.
    const safeSubject = sanitizeHeaderValue(params.subject).slice(0, 200);
    const safeTo = sanitizeHeaderValue(params.to);
    if (safeTo !== params.to || safeTo.includes(",")) {
      throw new Error(`smtp sender: rejected \`to\` containing control chars or list separators`);
    }

    // Build the MIME once so we can send it via SMTP and keep the bytes
    // for an IMAP APPEND into the Sent folder. Doing this in one pass
    // guarantees that what Thunderbird reads from Sent is byte-identical
    // to what the receiver saw — no risk of drift between two composes.
    const composer = new MailComposer({
      from: this.from,
      to: safeTo,
      subject: safeSubject,
      text: params.text,
      ...(params.html !== undefined ? { html: params.html } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
    });
    const raw = await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((err, message) => {
        if (err) reject(err);
        else resolve(message);
      });
    });

    const info = await this.transporter.sendMail({
      envelope: { from: this.from, to: safeTo },
      raw,
    });

    this.rememberSentId(info.messageId);
    this.logger.info("smtp sent", {
      accountId: this.accountId,
      to: params.to,
      messageId: info.messageId,
    });
    return { messageId: info.messageId, raw };
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

/**
 * Strip CR, LF, NUL and other ASCII control chars that could break a header
 * line. Mail-header-injection (RFC 5322 §2.2) happens via bare CRLF in a
 * header value; we normalize them to spaces instead of erroring so that
 * legitimate senders whose subject contains a literal newline don't get
 * their reply silently dropped.
 */
function sanitizeHeaderValue(v: string): string {
  return v.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
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
