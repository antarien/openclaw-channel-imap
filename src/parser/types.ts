import type { InboundAuthResults } from "./auth-results.js";

export interface InboundAddress {
  name: string;
  address: string;
}

/**
 * Attachment metadata without the body buffer. Use `InboundMessage.getAttachment(index)`
 * to materialize the actual bytes on demand.
 */
export interface AttachmentMeta {
  index: number;
  filename: string | undefined;
  contentType: string;
  contentDisposition: string;
  size: number;
  cid: string | undefined;
  related: boolean;
  checksum: string;
}

export interface InboundMessageSource {
  accountId: string;
  uid: number;
  mailbox: string;
  internalDate: Date | undefined;
  flags: ReadonlySet<string>;
}

/**
 * Normalized form of a single inbound email. Keep this minimal — richer
 * fields can be added as specific consumers need them.
 *
 * Attachments are metadata-only; call `getAttachment(index)` when a consumer
 * actually needs the bytes. The callback keeps a closure over the raw source
 * buffer so that a 20 MB PDF does not sit in the event payload forever.
 */
export interface InboundMessage {
  messageId: string | undefined;
  inReplyTo: string | undefined;
  references: readonly string[];
  date: Date | undefined;
  subject: string;
  from: InboundAddress | undefined;
  to: readonly InboundAddress[];
  cc: readonly InboundAddress[];
  bcc: readonly InboundAddress[];
  replyTo: InboundAddress | undefined;
  text: string | undefined;
  html: string | false;
  attachments: readonly AttachmentMeta[];
  authResults: InboundAuthResults;
  /**
   * RFC 5321 envelope sender, extracted from the `Return-Path:` header that
   * the receiving MTA (Postfix/Dovecot LMTP) stamped on delivery. This is
   * the address SPF actually validated, NOT the display-From, NOT Reply-To,
   * NOT anything the sender directly controls. Use this — never the header
   * From — as the reply target.
   *
   * `undefined` when the receiving MTA did not stamp Return-Path, which
   * signals a misconfigured delivery pipeline and must be treated as unsafe.
   */
  envelopeFrom: string | undefined;
  source: InboundMessageSource;
  getAttachment(index: number): Promise<Buffer>;
}
