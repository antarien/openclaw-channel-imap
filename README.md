# @antarien/openclaw-channel-imap

OpenClaw channel plugin for IMAP/SMTP mailboxes — IDLE-based push, reply threading, secure-by-default.

**Status:** alpha. Inbound + outbound flow is wired end-to-end; not yet production-hardened. No sandbox test against a real mail server yet (Phase 4).

## Why this plugin exists

As of 2026-04, there is no trustworthy IMAP/SMTP channel plugin for OpenClaw:

- `openclaw/openclaw#3632` (Email Channel feature request): closed
- `openclaw/openclaw#22183` (Email channel MVP): closed stale — maintainers explicitly prefer plugin over core
- `openclaw/openclaw#32673` (IMAP hook via himalaya PR): closed not merged
- `aibot505/openclaw-email-channel` on npm: single-day drive-by push by a two-month-old anonymous account, 0 stars, 0 forks, `package.json` claims an unrelated party as author. Not audited, not recommended.

This plugin aims to fill that gap with a maintained, auditable, TypeScript-strict implementation.

## Design goals

- **IDLE push** — no polling, sub-second latency when the server supports `IDLE`
- **Reply threading** — proper `In-Reply-To` + `References` headers so mail clients see threads
- **Secrets out of config files** — credentials via OS keyring or `pass` integration, never plain in settings (Phase 4)
- **Minimal trusted dependencies** — `imapflow` (IMAP) + `nodemailer` (SMTP) + `mailparser`, all well-established
- **No feature creep** — IMAP/SMTP only; POP3, Exchange/EWS, Gmail API are out of scope

## Architecture

```
                IDLE push
MailServer ───────────────► ImapConnection
                              │  emits `message`
                              ▼
                         InboundAccountManager  (one per plugin instance, Map<accountId, conn>)
                              │  emits `(accountId, raw)`
                              ▼
                          parseFetchedMessage    (mailparser — metadata-only attachments)
                              │  → InboundMessage
                              ▼
                          dispatchInbound
                              │
                ┌─────────────┼──────────────────────┐
                ▼             ▼                      ▼
        resolveAgentRoute  recordInboundSession  dispatchReplyWithBuffered…
                                                      │
                                                      ▼
                                                  deliver(ReplyPayload)
                                                      │
                                                      ▼  (SMTP, In-Reply-To + References)
                                                  MailServer
```

One `ImapConnection` per account, one `SmtpSender` transport per account. Both long-lived; reconnect is exponential (1s → 60s). `abortSignal` from `ChannelGatewayContext` tears both down cleanly.

## Configuration

Per-account blob under `channels.imap.accounts.<accountId>`:

```yaml
channels:
  imap:
    accounts:
      amilo:
        enabled: true
        imap:
          host: mail.example.com
          port: 993
          secure: true
          user: amilo@example.com
          password: !secret IMAP_PASSWORD_AMILO   # Phase 4
          mailbox: INBOX
        smtp:
          host: mail.example.com
          port: 465
          secure: true
          user: amilo@example.com
          password: !secret SMTP_PASSWORD_AMILO   # Phase 4
          from: "Amilo <amilo@example.com>"
```

Multi-account is first-class: add another key under `accounts:` and the plugin spins up an independent IDLE worker + SMTP transport for it.

## Status / roadmap

- [x] Phase 0: Audit OpenClaw plugin contract (telegram channel as reference)
- [x] Phase 1: Repo skeleton + plugin manifest
- [x] Phase 2.1: IMAP IDLE worker with auto-reconnect
- [x] Phase 2.2: Multi-account manager
- [x] Phase 2.3: Mail parser → normalized `InboundMessage`
- [x] Phase 2.4 + 3: Inbound dispatch wired to OpenClaw runtime + SMTP outbound with reply-threading
- [x] Phase 2.5: Plugin manifest + README aligned with actual config shape
- [ ] Phase 4: Secrets management (keyring / `pass`) + sandbox test against a real server (Dovecot)
- [ ] Phase 5: v0.1.0 release + community-plugin PR at `openclaw/openclaw`

## Development

```bash
npm install
npm run typecheck
npm run build
```

Strict TypeScript, zero audit findings.

## License

MIT — see [LICENSE](LICENSE).
