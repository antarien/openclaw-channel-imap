import type { SecretResolver } from "./types.js";
import { PassSecretResolver } from "./pass-resolver.js";
import { EnvSecretResolver } from "./env-resolver.js";

type Backend = "pass" | "env";

/**
 * Build the SecretResolver for the plugin from the channel-level config.
 *
 * Expected shape (under `channels.imap.secrets`):
 *
 *   backend: pass | env      # defaults to "pass"
 *   binary?: string          # pass-only, override binary name/path
 *   timeoutMs?: number       # pass-only, default 5000
 */
export function buildSecretResolverFromConfig(cfg: unknown): SecretResolver {
  const secretsCfg = readSecretsBlob(cfg);
  const backend = normalizeBackend(secretsCfg.backend);
  if (backend === "env") {
    return new EnvSecretResolver();
  }
  return new PassSecretResolver({
    ...(typeof secretsCfg.binary === "string" && secretsCfg.binary.length > 0
      ? { binary: secretsCfg.binary }
      : {}),
    ...(typeof secretsCfg.timeoutMs === "number" && secretsCfg.timeoutMs > 0
      ? { timeoutMs: secretsCfg.timeoutMs }
      : {}),
  });
}

function normalizeBackend(raw: unknown): Backend {
  if (raw === "env") return "env";
  if (raw === "pass" || raw === undefined) return "pass";
  throw new Error(`imap plugin: unsupported secrets.backend "${String(raw)}" (expected "pass" or "env")`);
}

function readSecretsBlob(cfg: unknown): Record<string, unknown> {
  if (!isRecord(cfg)) return {};
  const channels = cfg.channels;
  if (!isRecord(channels)) return {};
  const imap = channels.imap;
  if (!isRecord(imap)) return {};
  const secrets = imap.secrets;
  if (!isRecord(secrets)) return {};
  return secrets;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
