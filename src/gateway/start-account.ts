import { InboundAccountManager } from "../connection/inbound-account-manager.js";
import { parseFetchedMessage } from "../parser/parse-message.js";
import { SmtpSender } from "../smtp/smtp-sender.js";
import type { Logger } from "../connection/logger.js";
import { consoleLogger } from "../connection/logger.js";
import type { ResolvedEmailAccount } from "./resolved-account.js";
import { dispatchInbound, type ChannelRuntimeSurface } from "./inbound-dispatcher.js";
import type { MaybeSecret, SecretResolver } from "../secrets/types.js";
import { isSecretRef } from "../secrets/types.js";

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

  manager.on("message", (emittedAccountId, raw) => {
    void (async () => {
      try {
        const parsed = await parseFetchedMessage(raw, {
          accountId: emittedAccountId,
          mailbox: account.imap.mailbox,
        });
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
