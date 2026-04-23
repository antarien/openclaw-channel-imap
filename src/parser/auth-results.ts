export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";

export interface InboundAuthResults {
  dkim: AuthVerdict;
  spf: AuthVerdict;
  dmarc: AuthVerdict;
  raw: string | undefined;
}

const KNOWN_VERDICTS: ReadonlySet<string> = new Set([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);

/**
 * Parse the value of one or more `Authentication-Results:` headers into a
 * coarse { dkim, spf, dmarc } verdict triple. We do not try to understand
 * ARC, chain validation, or `d=` parameters — a receiving Rspamd (antarien)
 * has already collapsed those into the top-level verdicts we read here.
 *
 * If no Authentication-Results header is present, all three default to
 * "none" — the caller must decide how to treat unauthenticated mail.
 */
export function parseAuthenticationResults(header: string | string[] | undefined): InboundAuthResults {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw || typeof raw !== "string" || raw.length === 0) {
    return { dkim: "none", spf: "none", dmarc: "none", raw: undefined };
  }
  return {
    dkim: extractVerdict(raw, "dkim"),
    spf: extractVerdict(raw, "spf"),
    dmarc: extractVerdict(raw, "dmarc"),
    raw,
  };
}

function extractVerdict(raw: string, method: "dkim" | "spf" | "dmarc"): AuthVerdict {
  const re = new RegExp(`\\b${method}\\s*=\\s*([A-Za-z]+)`, "i");
  const m = re.exec(raw);
  const captured = m?.[1];
  if (!captured) return "none";
  const v = captured.toLowerCase();
  return KNOWN_VERDICTS.has(v) ? (v as AuthVerdict) : "none";
}
