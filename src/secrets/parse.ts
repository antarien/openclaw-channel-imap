import type { MaybeSecret, SecretRef } from "./types.js";

const SECRET_PREFIX = "!secret ";

/**
 * Parse a user-supplied string. If it starts with `!secret `, the rest is
 * captured as a deferred SecretRef; otherwise the string is returned as-is.
 *
 * Example: `"!secret imap/amilo"` -> `{ kind: "secret", ref: "imap/amilo" }`.
 */
export function parseMaybeSecret(raw: string): MaybeSecret {
  if (!raw.startsWith(SECRET_PREFIX)) return raw;
  const ref = raw.slice(SECRET_PREFIX.length).trim();
  if (ref.length === 0) {
    throw new Error(`config: empty secret ref after "${SECRET_PREFIX}"`);
  }
  const token: SecretRef = { kind: "secret", ref };
  return token;
}
