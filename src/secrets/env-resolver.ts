import type { SecretResolver } from "./types.js";
import { SecretResolutionError } from "./types.js";

const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * SecretResolver backed by process environment variables.
 *
 * Intended as a fallback / test backend. The `pass`-backed resolver is the
 * production default; env-based secrets leave plaintext in /proc/<pid>/environ
 * and any child process launched without explicit env scrubbing.
 */
export class EnvSecretResolver implements SecretResolver {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async resolve(ref: string): Promise<string> {
    if (!SAFE_ENV_NAME.test(ref)) {
      throw new SecretResolutionError(
        "env: secret ref must be a shell-safe env var name (uppercase letters, digits, underscore)",
        ref,
      );
    }
    const value = this.env[ref];
    if (value === undefined || value.length === 0) {
      throw new SecretResolutionError(`env: variable "${ref}" is not set or empty`, ref);
    }
    return value;
  }
}
