export interface RateLimitConfig {
  disabled: boolean;
  perAccountPerMinute: number;
  perAccountPerHour: number;
  perSenderPerHour: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason: string | undefined;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  disabled: false,
  perAccountPerMinute: 10,
  perAccountPerHour: 100,
  perSenderPerHour: 5,
};

export function resolveRateLimitConfig(raw: unknown): RateLimitConfig {
  if (!isRecord(raw)) return DEFAULT_RATE_LIMIT;
  return {
    disabled: typeof raw.disabled === "boolean" ? raw.disabled : DEFAULT_RATE_LIMIT.disabled,
    perAccountPerMinute: readPositiveInt(raw.perAccountPerMinute, DEFAULT_RATE_LIMIT.perAccountPerMinute),
    perAccountPerHour: readPositiveInt(raw.perAccountPerHour, DEFAULT_RATE_LIMIT.perAccountPerHour),
    perSenderPerHour: readPositiveInt(raw.perSenderPerHour, DEFAULT_RATE_LIMIT.perSenderPerHour),
  };
}

interface Counter {
  windowStart: number;
  count: number;
}

interface AccountState {
  minute: Counter;
  hour: Counter;
  sendersHour: Map<string, Counter>;
}

/**
 * In-memory rate limiter. Two windows per account (1 min, 1 h) plus one
 * 1 h window per envelope-from. Restart resets all counters — this is a
 * DoS throttle, not an audit log. Memory is bounded by the number of
 * distinct sender addresses seen within an hour; stale sender entries
 * are pruned opportunistically on each check.
 *
 * `checkAndConsume` runs the three windows in order and consumes tokens
 * only if ALL three pass, so a near-limit call does not partially
 * advance counters when another window rejects.
 */
export class RateLimiter {
  private readonly accounts = new Map<string, AccountState>();

  constructor(private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT) {}

  checkAndConsume(accountId: string, envelopeFrom: string): RateLimitDecision {
    if (this.config.disabled) return { allowed: true, reason: undefined };

    const now = Date.now();
    const state = this.ensureAccount(accountId);
    this.pruneSenders(state, now);

    const minuteDecision = this.inspect(state.minute, now, 60_000, this.config.perAccountPerMinute);
    if (!minuteDecision.allowed) {
      return {
        allowed: false,
        reason: `per-account minute limit exceeded (${this.config.perAccountPerMinute}/min, account=${accountId})`,
      };
    }
    const hourDecision = this.inspect(state.hour, now, 3_600_000, this.config.perAccountPerHour);
    if (!hourDecision.allowed) {
      return {
        allowed: false,
        reason: `per-account hour limit exceeded (${this.config.perAccountPerHour}/h, account=${accountId})`,
      };
    }
    const senderCounter = this.ensureSender(state, envelopeFrom);
    const senderDecision = this.inspect(senderCounter, now, 3_600_000, this.config.perSenderPerHour);
    if (!senderDecision.allowed) {
      return {
        allowed: false,
        reason: `per-sender hour limit exceeded (${this.config.perSenderPerHour}/h, sender=${envelopeFrom})`,
      };
    }

    this.consume(state.minute, now, 60_000);
    this.consume(state.hour, now, 3_600_000);
    this.consume(senderCounter, now, 3_600_000);
    return { allowed: true, reason: undefined };
  }

  private ensureAccount(accountId: string): AccountState {
    let s = this.accounts.get(accountId);
    if (!s) {
      s = { minute: { windowStart: 0, count: 0 }, hour: { windowStart: 0, count: 0 }, sendersHour: new Map() };
      this.accounts.set(accountId, s);
    }
    return s;
  }

  private ensureSender(state: AccountState, envelopeFrom: string): Counter {
    const key = envelopeFrom.toLowerCase();
    let c = state.sendersHour.get(key);
    if (!c) {
      c = { windowStart: 0, count: 0 };
      state.sendersHour.set(key, c);
    }
    return c;
  }

  private pruneSenders(state: AccountState, now: number): void {
    const cutoff = now - 3_600_000;
    for (const [k, c] of state.sendersHour) {
      if (c.windowStart < cutoff) state.sendersHour.delete(k);
    }
  }

  private inspect(c: Counter, now: number, windowMs: number, limit: number): RateLimitDecision {
    if (now - c.windowStart >= windowMs) return { allowed: true, reason: undefined };
    return c.count < limit
      ? { allowed: true, reason: undefined }
      : { allowed: false, reason: undefined };
  }

  private consume(c: Counter, now: number, windowMs: number): void {
    if (now - c.windowStart >= windowMs) {
      c.windowStart = now;
      c.count = 1;
    } else {
      c.count += 1;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}
