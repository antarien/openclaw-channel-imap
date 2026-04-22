import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from "mailparser";
import type { FetchMessageObject } from "imapflow";
import type {
  AttachmentMeta,
  InboundAddress,
  InboundMessage,
  InboundMessageSource,
} from "./types.js";

export interface ParseContext {
  accountId: string;
  mailbox: string;
}

export async function parseFetchedMessage(
  raw: FetchMessageObject,
  ctx: ParseContext,
): Promise<InboundMessage> {
  if (!raw.source) {
    throw new Error(`imap parser: FetchMessageObject for uid=${raw.uid} has no source`);
  }
  const source = raw.source;
  const parsed = await simpleParser(source);

  const attachments = parsed.attachments.map(toAttachmentMeta);
  const uid = Number(raw.uid);

  const internalDate =
    raw.internalDate instanceof Date
      ? raw.internalDate
      : typeof raw.internalDate === "string"
        ? new Date(raw.internalDate)
        : undefined;

  const messageSource: InboundMessageSource = {
    accountId: ctx.accountId,
    uid,
    mailbox: ctx.mailbox,
    internalDate,
    flags: new Set(raw.flags ?? []),
  };

  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: normalizeReferences(parsed.references),
    date: parsed.date,
    subject: parsed.subject ?? "",
    from: firstAddress(parsed.from),
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    bcc: flattenAddresses(parsed.bcc),
    replyTo: firstAddress(parsed.replyTo),
    text: parsed.text,
    html: parsed.html,
    attachments,
    source: messageSource,
    getAttachment: async (index: number): Promise<Buffer> => {
      const att = parsed.attachments[index];
      if (!att) {
        throw new Error(`imap parser: attachment index ${index} out of range`);
      }
      return att.content;
    },
  };
}

function toAttachmentMeta(att: Attachment, index: number): AttachmentMeta {
  return {
    index,
    filename: att.filename,
    contentType: att.contentType,
    contentDisposition: att.contentDisposition,
    size: att.size,
    cid: att.cid,
    related: att.related,
    checksum: att.checksum,
  };
}

function normalizeReferences(ref: string | string[] | undefined): readonly string[] {
  if (!ref) return [];
  return Array.isArray(ref) ? ref : [ref];
}

function firstAddress(obj: AddressObject | AddressObject[] | undefined): InboundAddress | undefined {
  if (!obj) return undefined;
  const flat = Array.isArray(obj) ? obj : [obj];
  for (const a of flat) {
    for (const e of a.value) {
      if (e.address) return { name: e.name ?? "", address: e.address };
    }
  }
  return undefined;
}

function flattenAddresses(
  obj: AddressObject | AddressObject[] | undefined,
): readonly InboundAddress[] {
  if (!obj) return [];
  const flat = Array.isArray(obj) ? obj : [obj];
  const out: InboundAddress[] = [];
  for (const a of flat) {
    for (const e of a.value) {
      if (e.address) out.push({ name: e.name ?? "", address: e.address });
    }
  }
  return out;
}
