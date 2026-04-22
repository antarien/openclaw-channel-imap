import { startEmailAccount, type AccountHandle } from "./gateway/start-account.js";
import { resolveEmailAccountFromConfig } from "./gateway/resolve-account.js";
import type { ResolvedEmailAccount } from "./gateway/resolved-account.js";
import type { ChannelRuntimeSurface } from "./gateway/inbound-dispatcher.js";
import { buildSecretResolverFromConfig } from "./secrets/build-resolver.js";

/**
 * Minimal shape of the ChannelGatewayContext we actually need. The real type
 * lives in openclaw/plugin-sdk/src/channels/plugins/types.adapters.d.ts and
 * includes a lot of fields we don't touch.
 */
interface GatewayContext {
  cfg: unknown;
  accountId: string;
  account: ResolvedEmailAccount;
  abortSignal: AbortSignal;
  channelRuntime?: ChannelRuntimeSurface;
}

const accountHandles = new Map<string, AccountHandle>();

export const imapPlugin = {
  id: "imap",
  meta: {
    label: "Email",
    systemImage: "envelope",
  },
  capabilities: {
    markdown: false,
    threads: true,
    groups: false,
    attachments: true,
  },
  config: {
    resolveAccount: (cfg: unknown, accountId?: string): ResolvedEmailAccount => {
      const id = accountId ?? "default";
      const raw = readAccountBlob(cfg, id);
      return resolveEmailAccountFromConfig(id, raw);
    },
  },
  gateway: {
    startAccount: async (ctx: GatewayContext): Promise<void> => {
      const existing = accountHandles.get(ctx.accountId);
      if (existing) {
        await existing.stop();
        accountHandles.delete(ctx.accountId);
      }
      const secretResolver = buildSecretResolverFromConfig(ctx.cfg);
      const dryRun = readDryRun(ctx.cfg);
      const handle = await startEmailAccount({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        account: ctx.account,
        channelRuntime: ctx.channelRuntime,
        abortSignal: ctx.abortSignal,
        secretResolver,
        dryRun,
      });
      accountHandles.set(ctx.accountId, handle);
    },
    stopAccount: async (ctx: GatewayContext): Promise<void> => {
      const handle = accountHandles.get(ctx.accountId);
      if (!handle) return;
      accountHandles.delete(ctx.accountId);
      await handle.stop();
    },
  },
} as const;

function readAccountBlob(cfg: unknown, accountId: string): unknown {
  if (!isRecord(cfg)) return {};
  const channels = cfg.channels;
  if (!isRecord(channels)) return {};
  const imap = channels.imap;
  if (!isRecord(imap)) return {};
  const accounts = imap.accounts;
  if (!isRecord(accounts)) return {};
  return accounts[accountId] ?? {};
}

function readDryRun(cfg: unknown): boolean {
  if (!isRecord(cfg)) return false;
  const channels = cfg.channels;
  if (!isRecord(channels)) return false;
  const imap = channels.imap;
  if (!isRecord(imap)) return false;
  return imap.dryRun === true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
