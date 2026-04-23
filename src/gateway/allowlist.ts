export interface AllowlistEntry {
  from?: string;
  domain?: string;
}

export interface AllowlistDecision {
  allowed: boolean;
  reason: string | undefined;
}

/**
 * Match an envelope-from address against an allowlist of rules. Each rule
 * matches EITHER a full address (`from`) OR a domain suffix (`domain`).
 *
 * An empty rule set means "no allowlist configured" — returns `allowed:
 * true`. This is opt-in by design: most installations start with legit
 * senders coming from arbitrary domains, and fail-closed-by-default
 * blocks all of them on day one. Once an allowlist is configured, it is
 * hard: envelope-from outside the list is dropped with a logged reason.
 *
 * Matching rules:
 *  - `from`:   exact lowercase match against envelope-from
 *  - `domain`: envelope-from ends with `@<domain>` (case-insensitive)
 *              OR `.<domain>` for multi-label suffix
 *
 * No globs, no regex, no wildcards — intentional. Simple rules are
 * auditable, complex rules hide bypasses.
 */
export function matchesAllowlist(
  envelopeFrom: string,
  rules: readonly AllowlistEntry[] | undefined,
): AllowlistDecision {
  if (!rules || rules.length === 0) {
    return { allowed: true, reason: undefined };
  }
  const ef = envelopeFrom.toLowerCase();
  for (const rule of rules) {
    if (typeof rule.from === "string" && rule.from.length > 0) {
      if (ef === rule.from.toLowerCase()) {
        return { allowed: true, reason: `matched from=${rule.from}` };
      }
    }
    if (typeof rule.domain === "string" && rule.domain.length > 0) {
      const dom = rule.domain.toLowerCase();
      if (ef.endsWith("@" + dom) || ef.endsWith("." + dom)) {
        return { allowed: true, reason: `matched domain=${rule.domain}` };
      }
    }
  }
  return { allowed: false, reason: "envelope-from not in allowlist" };
}

export function normalizeAllowlist(raw: unknown): readonly AllowlistEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AllowlistEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const entry: AllowlistEntry = {};
    if (typeof rec.from === "string" && rec.from.length > 0) {
      entry.from = rec.from;
    }
    if (typeof rec.domain === "string" && rec.domain.length > 0) {
      entry.domain = rec.domain;
    }
    if (entry.from !== undefined || entry.domain !== undefined) {
      out.push(entry);
    }
  }
  return out.length > 0 ? out : undefined;
}
