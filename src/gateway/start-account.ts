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

  if (!ctx.channelRuntime) {
    logger.warn("channelRuntime unavailable — running in inbound-log-only mode", { accountId });
  }

  let imapPassword: string;
  let smtpPassword: string;
  try {
    imapPassword = await resolveSecretValue(account.imap.password, ctx.secretResolver);
    smtpPassword = await resolveSecretValue(account.smtp.password, ctx.secretResolver);
  } catch (err) {
    logger.error("secret resolution failed", {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const smtp = new SmtpSender({
    accountId,
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    user: account.smtp.user,
    password: smtpPassword,
    from: account.smtp.from,
    logger,
  });

  const manager = new InboundAccountManager({ logger });

  manager.on("message", (emittedAccountId, raw) => {
    void (async () => {
      try {
        const parsed = await parseFetchedMessage(raw, {
          accountId: emittedAccountId,
          mailbox: account.imap.mailbox,
        });
        if (!ctx.channelRuntime) {
          logger.info("inbound (no runtime, dropping)", {
            accountId: emittedAccountId,
            from: parsed.from?.address,
            subject: parsed.subject,
            messageId: parsed.messageId,
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
    smtp.close();
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
