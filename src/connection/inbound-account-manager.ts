import { EventEmitter } from "node:events";
import type { FetchMessageObject } from "imapflow";
import { ImapConnection, type ImapConnectionOptions } from "./imap-connection.js";
import type { Logger } from "./logger.js";
import { consoleLogger } from "./logger.js";

export type AccountConfig = Omit<ImapConnectionOptions, "logger">;

export interface InboundAccountManagerEvents {
  connected: [accountId: string];
  disconnected: [accountId: string, reason: "logout" | "error" | "close"];
  message: [accountId: string, msg: FetchMessageObject];
  error: [accountId: string, err: Error];
}

export interface InboundAccountManagerOptions {
  logger?: Logger;
}

/**
 * Owns one ImapConnection per accountId, forwards events with accountId attached.
 *
 * - `upsert`: add new account, or replace an existing one (stop-then-start).
 * - `remove`: stop + forget an account.
 * - `stopAll`: shut down every account (plugin lifecycle stop).
 *
 * Connections are independent; one account failing does not affect others.
 */
export class InboundAccountManager extends EventEmitter<InboundAccountManagerEvents> {
  private readonly connections = new Map<string, ImapConnection>();
  private readonly logger: Logger;

  constructor(options: InboundAccountManagerOptions = {}) {
    super();
    this.logger = options.logger ?? consoleLogger;
  }

  has(accountId: string): boolean {
    return this.connections.has(accountId);
  }

  list(): string[] {
    return Array.from(this.connections.keys());
  }

  async upsert(config: AccountConfig): Promise<void> {
    if (config.accountId !== config.accountId.trim() || config.accountId.length === 0) {
      throw new Error("accountId must be a non-empty trimmed string");
    }
    const existing = this.connections.get(config.accountId);
    if (existing) {
      await existing.stop();
      this.connections.delete(config.accountId);
    }
    const conn = new ImapConnection({ ...config, logger: this.logger });
    conn.on("connected", () => this.emit("connected", config.accountId));
    conn.on("disconnected", (reason) => this.emit("disconnected", config.accountId, reason));
    conn.on("message", (msg) => this.emit("message", config.accountId, msg));
    conn.on("error", (err) => this.emit("error", config.accountId, err));
    this.connections.set(config.accountId, conn);
    conn.start();
  }

  async remove(accountId: string): Promise<void> {
    const conn = this.connections.get(accountId);
    if (!conn) return;
    this.connections.delete(accountId);
    await conn.stop();
  }

  async stopAll(): Promise<void> {
    const all = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.allSettled(all.map((c) => c.stop()));
  }
}
