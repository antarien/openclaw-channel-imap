# @antarien/openclaw-channel-imap

OpenClaw channel plugin for IMAP/SMTP mailboxes — IDLE-based push, reply threading, secure-by-default.

**Status:** alpha — not yet production-ready. Skeleton only; runtime not implemented.

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
- **Secrets out of config files** — credentials via OS keyring or `pass` integration, never plain in settings
- **Minimal trusted dependencies** — `imapflow` (IMAP) + `nodemailer` (SMTP) + `mailparser`, all well-established
- **No feature creep** — IMAP/SMTP only; POP3, Exchange/EWS, Gmail API are out of scope

## Status / roadmap

- [x] Phase 0: Audit OpenClaw plugin contract (telegram channel as reference)
- [x] Phase 1: Repo skeleton + plugin manifest
- [ ] Phase 2: IMAP IDLE worker + inbound push to gateway
- [ ] Phase 3: SMTP outbound + reply threading
- [ ] Phase 4: Secrets management (keyring / `pass`) + sandbox test
- [ ] Phase 5: v0.1.0 release + community-plugin PR at `openclaw/openclaw`

## License

MIT — see [LICENSE](LICENSE).
