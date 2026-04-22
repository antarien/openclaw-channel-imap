/**
 * A secret reference carried through the config after structural parsing.
 * The resolver turns this into a plaintext value at account-start time; it
 * is never cached and never logged.
 */
export interface SecretRef {
  readonly kind: "secret";
  readonly ref: string;
}

/** Either a literal plaintext string, or a deferred secret reference. */
export type MaybeSecret = string | SecretRef;

export function isSecretRef(v: unknown): v is SecretRef {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as SecretRef).kind === "secret" &&
    typeof (v as SecretRef).ref === "string"
  );
}

export interface SecretResolver {
  /**
   * Look up `ref` in the underlying store and return the plaintext value.
   * Implementations must not log the resolved value, not cache it, and not
   * include store-sensitive detail (like GPG-agent state) in error messages.
   */
  resolve(ref: string): Promise<string>;
}

export class SecretResolutionError extends Error {
  constructor(
    message: string,
    public readonly ref: string,
  ) {
    super(message);
    this.name = "SecretResolutionError";
  }
}
