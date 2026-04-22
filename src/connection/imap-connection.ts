import { EventEmitter } from "node:events";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import type { Logger } from "./logger.js";
import { consoleLogger } from "./logger.js";

export interface ImapConnectionOptions {
  accountId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox?: string;
  /** Reconnect backoff floor (ms). Default 1000. */
  reconnectMinMs?: number;
  /** Reconnect backoff ceiling (ms). Default 60_000. */
  reconnectMaxMs?: number;
  logger?: Logger;
}

export interface ImapConnectionEvents {
  connected: [];
  disconnected: [reason: "logout" | "error" | "close"];
  message: [msg: FetchMessageObject];
  error: [err: Error];
}

/**
 * Long-lived IMAP connection with IDLE and auto-reconnect.
 *
 * Emits `message` for every newly-arrived mail while the connection is up.
 * Reconnects with exponential backoff on drop, without dropping the caller's
 * subscription (events wire once, the internal client is swapped).
 */
export class ImapConnection extends EventEmitter<ImapConnectionEvents> {
  private readonly opts: Required<Omit<ImapConnectionOptions, "logger">> & { logger: Logger };
  private running = false;
  private client: ImapFlow | null = null;
  private lastSeenUid = 0;
  private backoffMs: number;
  private fetchInFlight = false;
  private reFetchRequested = false;

  constructor(options: ImapConnectionOptions) {
    super();
    this.opts = {
      accountId: options.accountId,
      host: options.host,
      port: options.port,
      secure: options.secure,
      user: options.user,
      password: options.password,
      mailbox: options.mailbox ?? "INBOX",
      reconnectMinMs: options.reconnectMinMs ?? 1000,
      reconnectMaxMs: options.reconnectMaxMs ?? 60_000,
      logger: options.logger ?? consoleLogger,
    };
    this.backoffMs = this.opts.reconnectMinMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  private async connectLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
        this.backoffMs = this.opts.reconnectMinMs;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.opts.logger.warn("connection lost", {
          accountId: this.opts.accountId,
          error: e.message,
        });
        this.emit("error", e);
      }
      if (!this.running) break;
      await this.sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.reconnectMaxMs);
    }
  }

  private async runOnce(): Promise<void> {
    const client = new ImapFlow({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: { user: this.opts.user, pass: this.opts.password },
      logger: false,
    });
    this.client = client;

    await client.connect();
    const mailbox = await client.mailboxOpen(this.opts.mailbox);
    this.lastSeenUid = Number(mailbox.uidNext ?? 1) - 1;
    this.opts.logger.info("connected", {
      accountId: this.opts.accountId,
      mailbox: mailbox.path,
      uidNext: mailbox.uidNext,
    });
    this.emit("connected");

    const closePromise = new Promise<"logout" | "error" | "close">((resolve) => {
      client.on("close", () => resolve("close"));
      client.on("error", () => resolve("error"));
    });

    client.on("exists", () => {
      void this.handleExists();
    });

    const reason = await closePromise;
    this.opts.logger.info("disconnected", {
      accountId: this.opts.accountId,
      reason,
    });
    this.emit("disconnected", reason);
    this.client = null;
  }

  private async handleExists(): Promise<void> {
    if (this.fetchInFlight) {
      this.reFetchRequested = true;
      return;
    }
    this.fetchInFlight = true;
    try {
      do {
        this.reFetchRequested = false;
        await this.fetchNewMessages();
      } while (this.reFetchRequested && this.running);
    } finally {
      this.fetchInFlight = false;
    }
  }

  private async fetchNewMessages(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const fromUid = this.lastSeenUid + 1;
    const range = `${fromUid}:*`;
    try {
      for await (const msg of client.fetch(
        range,
        { uid: true, envelope: true, source: true, flags: true, internalDate: true },
        { uid: true },
      )) {
        const uid = Number(msg.uid);
        if (uid <= this.lastSeenUid) continue;
        this.lastSeenUid = uid;
        this.emit("message", msg);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.opts.logger.error("fetch failed", {
        accountId: this.opts.accountId,
        error: e.message,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
