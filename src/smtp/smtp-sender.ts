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

/**
 * SMTP outbound sender. One long-lived nodemailer transport per account.
 * Reply-threading is built from `inReplyTo` + `references` (RFC 5322 / 2822).
 */
export class SmtpSender {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly logger: Logger;
  private readonly accountId: string;

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

    this.logger.info("smtp sent", {
      accountId: this.accountId,
      to: params.to,
      messageId: info.messageId,
    });
    return info.messageId;
  }

  close(): void {
    this.transporter.close();
  }
}

function angleWrap(id: string): string {
  const s = id.trim();
  return s.startsWith("<") ? s : `<${s}>`;
}
