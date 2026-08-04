import { ImapFlow } from "imapflow";
import type { Logger } from "./logger.js";
import { consoleLogger } from "./logger.js";
import type { ResolvedPostProcessConfig } from "../gateway/resolved-account.js";

export interface InboundPostProcessorOptions {
  accountId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  postProcess?: ResolvedPostProcessConfig;
  logger?: Logger;
}

export interface InboundPostProcessMessage {
  mailbox: string;
  uid: number;
  messageId?: string;
}

export class InboundPostProcessor {
  private readonly opts: Required<Omit<InboundPostProcessorOptions, "logger" | "postProcess">> & {
    logger: Logger;
    postProcess: ResolvedPostProcessConfig | undefined;
  };

  constructor(options: InboundPostProcessorOptions) {
    this.opts = {
      accountId: options.accountId,
      host: options.host,
      port: options.port,
      secure: options.secure,
      user: options.user,
      password: options.password,
      postProcess: options.postProcess,
      logger: options.logger ?? consoleLogger,
    };
  }

  isEnabled(): boolean {
    return this.opts.postProcess?.markSeen === true;
  }

  async process(message: InboundPostProcessMessage): Promise<void> {
    if (!this.isEnabled()) return;

    const client = new ImapFlow({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: { user: this.opts.user, pass: this.opts.password },
      logger: false,
    });

    try {
      await client.connect();
      await client.mailboxOpen(message.mailbox);
      await client.messageFlagsAdd([message.uid], ["\\Seen"], { uid: true });
      this.opts.logger.info("inbound post-process markSeen ok", {
        accountId: this.opts.accountId,
        mailbox: message.mailbox,
        uid: message.uid,
        messageId: message.messageId,
      });
    } catch (err) {
      this.opts.logger.warn("inbound post-process failed", {
        accountId: this.opts.accountId,
        mailbox: message.mailbox,
        uid: message.uid,
        messageId: message.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }
}
