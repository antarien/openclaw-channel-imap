import {
  defineBundledChannelEntry,
  type BundledChannelEntryContract,
} from "openclaw/plugin-sdk/channel-entry-contract";

const entry: BundledChannelEntryContract = defineBundledChannelEntry({
  id: "imap",
  name: "Email",
  description: "IMAP/SMTP channel plugin — IDLE-based push, reply threading",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "imapPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setImapRuntime",
  },
});

export default entry;
