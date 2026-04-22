import { spawn } from "node:child_process";
import type { SecretResolver } from "./types.js";
import { SecretResolutionError } from "./types.js";

/**
 * Allowed characters in a pass(1) path: letters, digits, `/`, `_`, `-`, `.`.
 * Deliberately tight — anything more exotic would be passed untouched to
 * argv[] by spawn(), but tight input validation is a cheap second line of
 * defence against mistakes (leading `-`, embedded newlines, etc.).
 */
const SAFE_PASS_REF = /^[A-Za-z0-9_][A-Za-z0-9/_.-]*$/;

export interface PassSecretResolverOptions {
  /** Binary path. Defaults to "pass" (resolved via PATH). */
  binary?: string;
  /** Hard timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Overrides for $HOME / $PASSWORD_STORE_DIR / $GNUPGHOME if needed. */
  env?: NodeJS.ProcessEnv;
}

/**
 * SecretResolver backed by the `pass(1)` password store.
 *
 * - Uses `spawn` with argv[] (no shell, no exec) so `ref` can never reach a
 *   shell interpreter regardless of its contents.
 * - Input is regex-validated before spawning; strings containing shell
 *   metacharacters, whitespace, or leading dashes are rejected up front.
 * - `pass show` can block on the gpg-agent passphrase prompt; the wrapper
 *   enforces a 5 s hard timeout and kills the subprocess on overrun.
 * - The resolved value is never logged. On error, the error message names
 *   the `ref` (which is not secret — it's a store path) and the failure
 *   kind, but never stdout/stderr (which could echo the secret on mis-config
 *   or leak gpg-agent state).
 */
export class PassSecretResolver implements SecretResolver {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(opts: PassSecretResolverOptions = {}) {
    this.binary = opts.binary ?? "pass";
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.env = opts.env;
  }

  async resolve(ref: string): Promise<string> {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new SecretResolutionError("pass: secret ref must be non-empty", ref);
    }
    if (!SAFE_PASS_REF.test(ref)) {
      throw new SecretResolutionError(
        "pass: secret ref contains invalid characters (allowed: A-Z a-z 0-9 / _ - .)",
        ref,
      );
    }

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(this.binary, ["show", ref], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(this.env ? { env: this.env } : {}),
      });

      const chunks: Buffer[] = [];
      let finished = false;
      const done = (err: Error | null, value?: string): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) reject(err);
        else if (value !== undefined) resolve(value);
      };

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        done(
          new SecretResolutionError(
            `pass: secret "${ref}" timed out after ${this.timeoutMs}ms (gpg-agent unreachable?)`,
            ref,
          ),
        );
      }, this.timeoutMs);

      proc.stdout.on("data", (d: Buffer) => chunks.push(d));
      proc.stderr.on("data", () => {
        // Intentionally discarded — stderr can echo secret on misconfig or
        // leak gpg-agent state. The exit code is enough signal.
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        const msg =
          err.code === "ENOENT"
            ? `pass: binary "${this.binary}" not found on PATH`
            : `pass: spawn failed (${err.code ?? "unknown"})`;
        done(new SecretResolutionError(msg, ref));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          done(
            new SecretResolutionError(
              `pass: "${ref}" lookup failed (exit ${code ?? "?"})`,
              ref,
            ),
          );
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        const firstLine = raw.split(/\r?\n/)[0] ?? "";
        if (firstLine.length === 0) {
          done(new SecretResolutionError(`pass: "${ref}" returned empty value`, ref));
          return;
        }
        done(null, firstLine);
      });
    });
  }
}
