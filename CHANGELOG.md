# Changelog

All notable changes to `@antarien/openclaw-channel-imap` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project loosely follows [Semantic Versioning](https://semver.org/) within the
`0.x` line — breaking changes may land in `0.1.0-alpha.N` versions.

## 0.1.0-alpha.6 — 2026-04-27

First public alpha release on npm under the `next` dist-tag.

### Added

- Initial public release of `@antarien/openclaw-channel-imap` — IMAP/SMTP channel
  plugin for OpenClaw.
- IMAP IDLE push with auto-reconnect (exponential backoff 1s → 60s),
  multi-account `InboundAccountManager`.
- SMTP outbound with reply threading (`In-Reply-To` + `References`), envelope-
  from pinning so reply targets can't be redirected by header forgery.
- Sent-folder archiving for outbound replies.
- Layered security hardening for untrusted inbound mail:
  - Authentication-Results gate (`requireAuthenticationResults`,
    `dropOnDkim/Spf/DmarcFail`) — all default-on, fail-closed.
  - Body sanitization — `<script>` / `<style>` blocks stripped, URLs extracted,
    body truncated to `maxBodyChars` (default 8000).
  - Untrusted-input wrapping — every inbound body is enveloped with an explicit
    preamble instructing the agent to treat the content as untrusted.
  - Sender allowlist (opt-in `from` + domain-suffix matching).
  - In-memory rate limit (per-account-per-minute, per-account-per-hour,
    per-sender-per-hour) — DoS throttle, defaults on.
- `!secret <ref>` resolver with `pass` (default, regex-validated, 5s timeout)
  and `env` backends. Plaintext secrets in config still work for local dev.
- `dryRun` mode — parse + log inbound only, no SMTP, no agent dispatch.
- Mailserver-hardening recipe shipped under
  [`docs/mailserver-hardening/`](docs/mailserver-hardening/README.md) — Postfix,
  Rspamd, Dovecot snippets + verify-pipeline script for fail-closed milter +
  `authserv_id` pinning.

### Known limitations

- Rate-limit counters are in-memory and reset on plugin restart.
- Per-channel agent tool/skill scoping is not plugin-controlled — must be
  configured on the OpenClaw side. Mail-facing agents should be given a
  conservative skill set.
- Live-tested against one Postfix + Dovecot deployment only.
