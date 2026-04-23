import { startEmailAccount, type AccountHandle } from "./gateway/start-account.js";
import { resolveEmailAccountFromConfig } from "./gateway/resolve-account.js";
import type { ResolvedEmailAccount } from "./gateway/resolved-account.js";
import type { ChannelRuntimeSurface } from "./gateway/inbound-dispatcher.js";
import { buildSecretResolverFromConfig } from "./secrets/build-resolver.js";
import { resolveSecurityConfig } from "./gateway/security-config.js";

/**
 * Minimal shape of the ChannelGatewayContext we actually need. The real type
 * lives in openclaw/plugin-sdk/src/channels/plugins/types.adapters.d.ts and
 * includes a lot of fields we don't touch.
 */
type StatusPatch = Partial<RuntimeState>;

interface GatewayContext {
  cfg: unknown;
  accountId: string;
  account: ResolvedEmailAccount;
  abortSignal: AbortSignal;
  channelRuntime?: ChannelRuntimeSurface;
  getStatus?: () => RuntimeState;
  setStatus?: (patch: StatusPatch) => void;
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
    listAccountIds: (cfg: unknown): string[] => {
      if (!isRecord(cfg)) return [];
      const channels = cfg.channels;
      if (!isRecord(channels)) return [];
      const imap = channels.imap;
      if (!isRecord(imap)) return [];
      const accounts = imap.accounts;
      if (!isRecord(accounts)) return [];
      return Object.keys(accounts);
    },
    resolveAccount: (cfg: unknown, accountId?: string | null): ResolvedEmailAccount => {
      const id = accountId && accountId.length > 0 ? accountId : "default";
      const raw = readAccountBlob(cfg, id);
      return resolveEmailAccountFromConfig(id, raw);
    },
    defaultAccountId: (cfg: unknown): string => {
      if (!isRecord(cfg)) return "default";
      const channels = cfg.channels;
      if (!isRecord(channels)) return "default";
      const imap = channels.imap;
      if (!isRecord(imap)) return "default";
      const accounts = imap.accounts;
      if (!isRecord(accounts)) return "default";
      const first = Object.keys(accounts)[0];
      return first ?? "default";
    },
    isEnabled: (account: ResolvedEmailAccount): boolean => account.enabled,
    isConfigured: (account: ResolvedEmailAccount): boolean => account.configured,
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
      const security = resolveSecurityConfig(readSecurityRaw(ctx.cfg));
      const handle = await startEmailAccount({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        account: ctx.account,
        channelRuntime: ctx.channelRuntime,
        abortSignal: ctx.abortSignal,
        secretResolver,
        dryRun,
        security,
        ...(ctx.setStatus ? { setStatus: ctx.setStatus } : {}),
      });
      accountHandles.set(ctx.accountId, handle);
      // The gateway treats a resolved startAccount as "task ended" and schedules
      // an auto-restart, which would tear down the long-lived IMAP IDLE worker.
      // Block here until abort; the inner ImapConnection runs its own reconnect
      // loop with exponential backoff and survives transient network drops.
      if (ctx.abortSignal.aborted) return;
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    stopAccount: async (ctx: GatewayContext): Promise<void> => {
      const handle = accountHandles.get(ctx.accountId);
      if (!handle) return;
      accountHandles.delete(ctx.accountId);
      await handle.stop();
    },
  },
  status: {
    buildAccountSnapshot: (params: StatusSnapshotParams): AccountStatusSnapshot => {
      const { account, runtime, probe } = params;
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        ...(typeof runtime?.connected === "boolean"
          ? { connected: runtime.connected }
          : {}),
        ...(typeof runtime?.lastConnectedAt === "number"
          ? { lastConnectedAt: runtime.lastConnectedAt }
          : {}),
        ...(runtime?.lastDisconnect ? { lastDisconnect: runtime.lastDisconnect } : {}),
        ...(typeof runtime?.reconnectAttempts === "number"
          ? { reconnectAttempts: runtime.reconnectAttempts }
          : {}),
        ...(typeof runtime?.restartPending === "boolean"
          ? { restartPending: runtime.restartPending }
          : {}),
        ...(probe !== undefined ? { probe } : {}),
      };
    },
    buildChannelSummary: (params: { snapshot: AccountStatusSnapshot }) => ({
      configured: params.snapshot.configured ?? false,
      running: params.snapshot.running ?? false,
      lastStartAt: params.snapshot.lastStartAt ?? null,
      lastStopAt: params.snapshot.lastStopAt ?? null,
      lastError: params.snapshot.lastError ?? null,
      ...(typeof params.snapshot.connected === "boolean"
        ? { connected: params.snapshot.connected }
        : {}),
      ...(typeof params.snapshot.lastConnectedAt === "number"
        ? { lastConnectedAt: params.snapshot.lastConnectedAt }
        : {}),
      ...(params.snapshot.lastInboundAt != null
        ? { lastInboundAt: params.snapshot.lastInboundAt }
        : {}),
    }),
  },
} as const;

interface RuntimeState {
  running?: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  reconnectAttempts?: number;
  restartPending?: boolean;
  connected?: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: { at: number; reason: string } | null;
}

interface StatusSnapshotParams {
  account: ResolvedEmailAccount;
  cfg: unknown;
  runtime?: RuntimeState;
  probe?: unknown;
  audit?: unknown;
}

interface AccountStatusSnapshot {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: { at: number; reason: string };
  reconnectAttempts?: number;
  restartPending?: boolean;
  probe?: unknown;
}

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

function readSecurityRaw(cfg: unknown): unknown {
  if (!isRecord(cfg)) return undefined;
  const channels = cfg.channels;
  if (!isRecord(channels)) return undefined;
  const imap = channels.imap;
  if (!isRecord(imap)) return undefined;
  return imap.security;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
