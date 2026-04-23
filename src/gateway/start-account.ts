import { InboundAccountManager } from "../connection/inbound-account-manager.js";
import { parseFetchedMessage } from "../parser/parse-message.js";
import { SmtpSender, extractBareAddress } from "../smtp/smtp-sender.js";
import type { Logger } from "../connection/logger.js";
import { consoleLogger } from "../connection/logger.js";
import type { ResolvedEmailAccount } from "./resolved-account.js";
import { dispatchInbound, type ChannelRuntimeSurface } from "./inbound-dispatcher.js";
import type { MaybeSecret, SecretResolver } from "../secrets/types.js";
import { isSecretRef } from "../secrets/types.js";
import {
  DEFAULT_SECURITY_CONFIG,
  decideAuthGate,
  type ResolvedSecurityConfig,
} from "./security-config.js";
import { matchesAllowlist } from "./allowlist.js";
import { RateLimiter } from "./rate-limit.js";

export interface StartAccountContext {
  cfg: unknown;
  accountId: string;
  account: ResolvedEmailAccount;
  channelRuntime?: ChannelRuntimeSurface | undefined;
  abortSignal: AbortSignal;
  logger?: Logger;
  secretResolver: SecretResolver;
  /**
   * When true, the account receives mail and parses it, but no SMTP transport
   * is opened and no dispatchReplyWithBufferedBlockDispatcher is ever called.
   * Inbound mail is logged as structured metadata so operators can verify the
   * IMAP + parser + threading path before arming outbound delivery.
   */
  dryRun?: boolean;
  /** Authentication gate + sanitization limits. Defaults fail closed. */
  security?: ResolvedSecurityConfig;
  /**
   * Gateway-provided runtime-state patcher. When present, connection lifecycle
   * and inbound events are mirrored into the shared account runtime store so
   * the gateway status adapter can surface `connected`, `lastConnectedAt`,
   * `lastDisconnect`, and `lastInboundAt` in `channels.status` responses.
   */
  setStatus?: (patch: {
    connected?: boolean;
    lastConnectedAt?: number | null;
    lastDisconnect?: { at: number; reason: string } | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
    lastError?: string | null;
  }) => void;
}

/** Own From-address extracted once per account, lower-cased for comparison. */
function selfAddress(account: ResolvedEmailAccount): string {
  return extractBareAddress(account.smtp.from);
}

/**
 * True when an inbound message is our own SMTP reply bouncing back into the
 * same mailbox (mailer routes amilo@… → amilo@…). Two independent signals:
 *   1. From-address equals our SMTP from-address.
 *   2. Message-ID (or a threading reference) is in our sent-id cache.
 * Either is sufficient; both fire in practice.
 */
function isSelfSend(
  parsed: {
    from: { address: string } | undefined;
    messageId: string | undefined;
    inReplyTo: string | undefined;
    references: readonly string[];
  },
  account: ResolvedEmailAccount,
  smtp: SmtpSender | null,
): { self: boolean; reason: string } {
  const fromAddr = parsed.from?.address?.toLowerCase();
  const own = selfAddress(account);
  if (fromAddr && own && fromAddr === own) {
    return { self: true, reason: "from-address matches SMTP from" };
  }
  if (smtp) {
    if (smtp.hasSentRecently(parsed.messageId)) {
      return { self: true, reason: "message-id in sent cache" };
    }
    if (smtp.hasSentRecently(parsed.inReplyTo)) {
      return { self: true, reason: "in-reply-to in sent cache" };
    }
    for (const ref of parsed.references) {
      if (smtp.hasSentRecently(ref)) {
        return { self: true, reason: "reference in sent cache" };
      }
    }
  }
  return { self: false, reason: "" };
}

/**
 * Handle returned from startAccount so the caller can shut everything down
 * from `stopAccount` without re-deriving the manager + sender.
 */
export interface AccountHandle {
  stop(): Promise<void>;
}

/**
 * Full per-account lifecycle: bring up the IMAP IDLE worker + SMTP transport,
 * wire the inbound flow through dispatchInbound, and tear both down on abort.
 */
export async function startEmailAccount(ctx: StartAccountContext): Promise<AccountHandle> {
  const logger = ctx.logger ?? consoleLogger;
  const { account, accountId } = ctx;
  const security = ctx.security ?? DEFAULT_SECURITY_CONFIG;
  const rateLimiter = new RateLimiter(security.rateLimit);

  if (!account.enabled || !account.configured) {
    logger.info("account skipped (disabled or not configured)", {
      accountId,
      enabled: account.enabled,
      configured: account.configured,
    });
    return { stop: async () => {} };
  }

  const dryRun = ctx.dryRun === true;
  if (dryRun) {
    logger.warn("DRY RUN mode — no SMTP transport, no dispatchReply", { accountId });
  } else if (!ctx.channelRuntime) {
    logger.warn("channelRuntime unavailable — running in inbound-log-only mode", { accountId });
  }

  let imapPassword: string;
  try {
    imapPassword = await resolveSecretValue(account.imap.password, ctx.secretResolver);
  } catch (err) {
    logger.error("imap secret resolution failed", {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  let smtp: SmtpSender | null = null;
  if (!dryRun) {
    let smtpPassword: string;
    try {
      smtpPassword = await resolveSecretValue(account.smtp.password, ctx.secretResolver);
    } catch (err) {
      logger.error("smtp secret resolution failed", {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    smtp = new SmtpSender({
      accountId,
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      user: account.smtp.user,
      password: smtpPassword,
      from: account.smtp.from,
      logger,
    });
  }

  const manager = new InboundAccountManager({ logger });
  const setStatus = ctx.setStatus;

  manager.on("connected", () => {
    setStatus?.({
      connected: true,
      lastConnectedAt: Date.now(),
      lastError: null,
    });
  });

  manager.on("disconnected", (_id, reason) => {
    setStatus?.({
      connected: false,
      lastDisconnect: { at: Date.now(), reason },
    });
  });

  manager.on("message", (emittedAccountId, raw) => {
    void (async () => {
      try {
        const parsed = await parseFetchedMessage(raw, {
          accountId: emittedAccountId,
          mailbox: account.imap.mailbox,
        });
        const loopCheck = isSelfSend(parsed, account, smtp);
        if (loopCheck.self) {
          logger.info("inbound skipped: self-send loop prevented", {
            accountId: emittedAccountId,
            uid: parsed.source.uid,
            messageId: parsed.messageId,
            from: parsed.from?.address,
            reason: loopCheck.reason,
          });
          return;
        }
        const envelopeFromEarly = parsed.envelopeFrom;
        if (envelopeFromEarly !== undefined) {
          const allow = matchesAllowlist(envelopeFromEarly, security.allowlist);
          if (!allow.allowed) {
            logger.warn("inbound dropped: sender not in allowlist", {
              accountId: emittedAccountId,
              uid: parsed.source.uid,
              messageId: parsed.messageId,
              envelopeFrom: envelopeFromEarly,
              headerFrom: parsed.from?.address,
            });
            return;
          }
        }
        const gate = decideAuthGate(parsed.authResults, security);
        if (gate.drop) {
          logger.warn("inbound dropped: authentication gate", {
            accountId: emittedAccountId,
            uid: parsed.source.uid,
            messageId: parsed.messageId,
            from: parsed.from?.address,
            reason: gate.reason,
            dkim: parsed.authResults.dkim,
            spf: parsed.authResults.spf,
            dmarc: parsed.authResults.dmarc,
            authHeaderPresent: parsed.authResults.raw !== undefined,
          });
          return;
        }
        if (envelopeFromEarly !== undefined) {
          const rl = rateLimiter.checkAndConsume(emittedAccountId, envelopeFromEarly);
          if (!rl.allowed) {
            logger.warn("inbound dropped: rate limit", {
              accountId: emittedAccountId,
              uid: parsed.source.uid,
              messageId: parsed.messageId,
              envelopeFrom: envelopeFromEarly,
              reason: rl.reason,
            });
            return;
          }
        }
        setStatus?.({ lastInboundAt: Date.now() });
        if (dryRun) {
          logger.info("DRY RUN inbound (no dispatch, no send)", {
            accountId: emittedAccountId,
            uid: parsed.source.uid,
            from: parsed.from?.address,
            to: parsed.to.map((a) => a.address),
            subject: parsed.subject,
            messageId: parsed.messageId,
            inReplyTo: parsed.inReplyTo,
            references: parsed.references.length,
            textBytes: parsed.text?.length ?? 0,
            attachments: parsed.attachments.length,
          });
          return;
        }
        if (!ctx.channelRuntime) {
          logger.info("inbound (no runtime, dropping)", {
            accountId: emittedAccountId,
            from: parsed.from?.address,
            subject: parsed.subject,
            messageId: parsed.messageId,
          });
          return;
        }
        if (!smtp) {
          logger.error("internal: smtp sender missing outside dryRun", {
            accountId: emittedAccountId,
          });
          return;
        }
        await dispatchInbound({
          cfg: ctx.cfg,
          accountId: emittedAccountId,
          account,
          channelRuntime: ctx.channelRuntime,
          inbound: parsed,
          smtp,
          logger,
          onOutbound: () => setStatus?.({ lastOutboundAt: Date.now() }),
        });
      } catch (err) {
        logger.error("inbound dispatch failed", {
          accountId: emittedAccountId,
          uid: Number(raw.uid),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  manager.on("error", (emittedAccountId, err) => {
    logger.warn("imap transport error", {
      accountId: emittedAccountId,
      error: err.message,
    });
  });

  await manager.upsert({
    accountId,
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    user: account.imap.user,
    password: imapPassword,
    mailbox: account.imap.mailbox,
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await manager.stopAll();
    if (smtp) smtp.close();
    logger.info("account stopped", { accountId });
  };

  if (ctx.abortSignal.aborted) {
    await stop();
  } else {
    ctx.abortSignal.addEventListener("abort", () => void stop(), { once: true });
  }

  return { stop };
}

async function resolveSecretValue(
  value: MaybeSecret,
  resolver: SecretResolver,
): Promise<string> {
  if (isSecretRef(value)) {
    return resolver.resolve(value.ref);
  }
  return value;
}
