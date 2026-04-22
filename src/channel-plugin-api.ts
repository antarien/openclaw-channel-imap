/**
 * Channel plugin definition. Phase 1 scaffolding — adapters implemented in Phase 2+.
 * See ChannelPlugin in openclaw/plugin-sdk/channel-core for full contract.
 */
export const imapPlugin = {
  id: "imap",
  meta: {
    label: "Email",
    systemImage: "envelope",
  },
  capabilities: {
    markdown: false,
    threads: true,
    groups: false,
    attachments: true,
  },
  config: {
    resolveAccount: async (): Promise<never> => {
      throw new Error("imap plugin: resolveAccount not yet implemented (Phase 2)");
    },
  },
} as const;
