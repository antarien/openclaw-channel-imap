import type { InboundMessage } from "../parser/types.js";
import type { SmtpSender } from "../smtp/smtp-sender.js";
import type { Logger } from "../connection/logger.js";
import type { ResolvedEmailAccount } from "./resolved-account.js";

/**
 * Runtime surface we actually call. Kept narrow (and typed as unknown) so we
 * don't drag every OpenClaw internal type into our strict build; the real
 * shapes live in openclaw/plugin-sdk/src/plugins/runtime/types-channel.d.ts.
 */
export interface ChannelRuntimeSurface {
  routing: {
    resolveAgentRoute: (input: {
      cfg: unknown;
      channel: string;
      accountId?: string | null;
      peer?: { kind: "direct" | "group" | "channel"; id: string } | null;
    }) => {
      agentId: string;
      channel: string;
      accountId: string;
      sessionKey: string;
      mainSessionKey: string;
      lastRoutePolicy: "main" | "session";
    };
  };
  session: {
    resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
    recordInboundSession: (params: {
      storePath: string;
      sessionKey: string;
      ctx: Record<string, unknown>;
      onRecordError: (err: unknown) => void;
    }) => Promise<void>;
  };
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: (params: {
      ctx: Record<string, unknown>;
      cfg: unknown;
      dispatcherOptions: {
        deliver: (
          payload: { text?: string; replyToId?: string; isError?: boolean },
          info: { kind: string },
        ) => Promise<void>;
      };
    }) => Promise<unknown>;
  };
}

export interface DispatchInboundParams {
  cfg: unknown;
  accountId: string;
  account: ResolvedEmailAccount;
  channelRuntime: ChannelRuntimeSurface;
  inbound: InboundMessage;
  smtp: SmtpSender;
  logger: Logger;
  /** Optional hook to update `lastOutboundAt` after each successful SMTP send. */
  onOutbound?: () => void;
}

const CHANNEL_ID = "imap";

/**
 * Full inbound path for a single parsed mail:
 *   1. Resolve agent route for this peer.
 *   2. Build + record the inbound session.
 *   3. Run dispatchReplyWithBufferedBlockDispatcher with an SMTP-backed deliver.
 *
 * All state related to the mail (subject, message id, references) is captured
 * in the deliver closure so SMTP threading is correct without additional state.
 */
export async function dispatchInbound(params: DispatchInboundParams): Promise<void> {
  const { cfg, accountId, channelRuntime, inbound, smtp, logger, onOutbound } = params;

  const fromAddress = inbound.from?.address;
  if (!fromAddress) {
    logger.warn("inbound dropped: no From address", {
      accountId,
      uid: inbound.source.uid,
      messageId: inbound.messageId,
    });
    return;
  }

  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: "direct", id: fromAddress },
  });

  const body = inbound.text ?? (inbound.html === false ? "" : stripHtml(inbound.html));

  const msgCtx: Record<string, unknown> = {
    Body: body,
    BodyForAgent: body,
    From: fromAddress,
    To: params.account.smtp.from,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    MessageSid: inbound.messageId,
    ReplyToId: inbound.inReplyTo,
  };

  const storePath = channelRuntime.session.resolveStorePath(undefined, { agentId: route.agentId });

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: msgCtx,
    onRecordError: (err) =>
      logger.error("recordInboundSession failed", {
        accountId,
        sessionKey: route.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      }),
  });

  const replySubject = prefixReplySubject(inbound.subject);
  const replyReferences = [...inbound.references];
  if (inbound.messageId) replyReferences.push(inbound.messageId);

  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        const text = payload.text?.trim();
        if (!text) return;
        try {
          await smtp.send({
            to: fromAddress,
            subject: replySubject,
            text,
            ...(inbound.messageId ? { inReplyTo: inbound.messageId } : {}),
            ...(replyReferences.length ? { references: replyReferences } : {}),
          });
          onOutbound?.();
        } catch (err) {
          logger.error("smtp deliver failed", {
            accountId,
            kind: info.kind,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    },
  });
}

function prefixReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re:";
  if (/^re:\s/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
