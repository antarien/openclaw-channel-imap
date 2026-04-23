import type { InboundAuthResults } from "../parser/auth-results.js";
import {
  normalizeAllowlist,
  type AllowlistEntry,
} from "./allowlist.js";
import {
  resolveRateLimitConfig,
  DEFAULT_RATE_LIMIT,
  type RateLimitConfig,
} from "./rate-limit.js";

export interface ResolvedSecurityConfig {
  requireAuthenticationResults: boolean;
  dropOnDkimFail: boolean;
  dropOnSpfFail: boolean;
  dropOnDmarcFail: boolean;
  maxBodyChars: number;
  allowlist: readonly AllowlistEntry[] | undefined;
  rateLimit: RateLimitConfig;
}

export interface AuthGateDecision {
  drop: boolean;
  reason: string | undefined;
}

/**
 * Safe defaults: every knob on. Opt out explicitly via config if you need
 * to accept mail that breaks DKIM (legit forwarders) or does not arrive
 * with an Authentication-Results header (misconfigured receiver).
 */
export const DEFAULT_SECURITY_CONFIG: ResolvedSecurityConfig = {
  requireAuthenticationResults: true,
  dropOnDkimFail: true,
  dropOnSpfFail: true,
  dropOnDmarcFail: true,
  maxBodyChars: 8000,
  allowlist: undefined,
  rateLimit: DEFAULT_RATE_LIMIT,
};

export function resolveSecurityConfig(raw: unknown): ResolvedSecurityConfig {
  if (!isRecord(raw)) return DEFAULT_SECURITY_CONFIG;
  return {
    requireAuthenticationResults: readBool(raw.requireAuthenticationResults, DEFAULT_SECURITY_CONFIG.requireAuthenticationResults),
    dropOnDkimFail: readBool(raw.dropOnDkimFail, DEFAULT_SECURITY_CONFIG.dropOnDkimFail),
    dropOnSpfFail: readBool(raw.dropOnSpfFail, DEFAULT_SECURITY_CONFIG.dropOnSpfFail),
    dropOnDmarcFail: readBool(raw.dropOnDmarcFail, DEFAULT_SECURITY_CONFIG.dropOnDmarcFail),
    maxBodyChars: readPositiveInt(raw.maxBodyChars, DEFAULT_SECURITY_CONFIG.maxBodyChars),
    allowlist: normalizeAllowlist(raw.allowlist),
    rateLimit: resolveRateLimitConfig(raw.rateLimit),
  };
}

/**
 * Given an auth result triple and a security config, decide whether to
 * accept the message. Runs the checks in order of severity. A `none`
 * verdict is only dropped via `requireAuthenticationResults` — that knob
 * fails closed when no Authentication-Results header was present at all.
 */
export function decideAuthGate(
  auth: InboundAuthResults,
  sec: ResolvedSecurityConfig,
): AuthGateDecision {
  if (sec.requireAuthenticationResults && auth.raw === undefined) {
    return { drop: true, reason: "Authentication-Results header missing (receiver did not run DKIM/SPF/DMARC milter)" };
  }
  if (sec.dropOnDmarcFail && auth.dmarc === "fail") {
    return { drop: true, reason: "DMARC fail (sender spoofing)" };
  }
  if (sec.dropOnDkimFail && auth.dkim === "fail") {
    return { drop: true, reason: "DKIM fail (signature invalid or domain mismatch)" };
  }
  if (sec.dropOnSpfFail && auth.spf === "fail") {
    return { drop: true, reason: "SPF fail (envelope sender not authorized)" };
  }
  return { drop: false, reason: undefined };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function readPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}
