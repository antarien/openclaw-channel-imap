import { simpleParser, type AddressObject, type Attachment } from "mailparser";
import type { FetchMessageObject } from "imapflow";
import type {
  AttachmentMeta,
  InboundAddress,
  InboundMessage,
  InboundMessageSource,
} from "./types.js";
import { parseAuthenticationResults } from "./auth-results.js";

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

  const authHeader = parsed.headers.get("authentication-results");
  const authResults = parseAuthenticationResults(
    typeof authHeader === "string"
      ? authHeader
      : Array.isArray(authHeader)
        ? (authHeader.filter((v): v is string => typeof v === "string"))
        : undefined,
  );

  const returnPath = parsed.headers.get("return-path");
  const envelopeFrom = extractReturnPathAddress(returnPath);

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
    authResults,
    envelopeFrom,
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

/**
 * Parse a `Return-Path:` header value into a bare `user@host` address.
 * RFC 5321 bounce messages use `<>` (empty) for null senders — we return
 * `undefined` in that case because there is nowhere safe to reply to.
 *
 * Accepts a string, string[], or mailparser's structured address object
 * shapes conservatively (mailparser parses Return-Path as an address field
 * and may surface it as `{ value: [{ address }] }`).
 */
function extractReturnPathAddress(header: unknown): string | undefined {
  if (header === undefined || header === null) return undefined;
  const raw = typeof header === "string"
    ? header
    : Array.isArray(header)
      ? header.find((v): v is string => typeof v === "string")
      : extractAddressFromStructured(header);
  if (typeof raw !== "string") return undefined;
  const inside = /<([^>]*)>/.exec(raw);
  const candidate = (inside?.[1] ?? raw).trim();
  if (candidate.length === 0) return undefined;
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(candidate)) return undefined;
  return candidate.toLowerCase();
}

function extractAddressFromStructured(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const val = (v as { value?: unknown }).value;
  if (!Array.isArray(val)) return undefined;
  for (const e of val) {
    if (typeof e === "object" && e !== null && typeof (e as { address?: unknown }).address === "string") {
      return (e as { address: string }).address;
    }
  }
  return undefined;
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
