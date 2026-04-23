# Mailserver Hardening — Prerequisites for `requireAuthenticationResults: true`

This plugin's default security config drops any inbound mail that arrives
**without** an `Authentication-Results:` header stamped by the receiving
MTA. That only works if the receiving MTA actually stamps one on every
delivery path. Bypasses anywhere in the pipeline (sieve-before-milter,
alternate LMTP, local submission) turn the plugin into "open".

The snippets in this directory configure the antarien mail stack
(Postfix + Rspamd + Dovecot + opendkim) so that **every** inbound mail
destined for a mailbox the plugin watches passes through the milter chain
and gets the header stamped.

**Do not apply blindly** — diff against your running config, back up
`/etc/postfix`, `/etc/rspamd`, `/etc/dovecot` first, restart services
one at a time and watch `mail.log`.

## Files

- [`postfix-main.cf.snippet`](postfix-main.cf.snippet) — enforce milter
  chain on every receive path, fail-closed if milter is unreachable.
- [`rspamd-milter_headers.conf`](rspamd-milter_headers.conf) — Rspamd
  adds `Authentication-Results:` on every delivery.
- [`dovecot-lmtp.conf.snippet`](dovecot-lmtp.conf.snippet) — Dovecot
  LMTP listens only on the socket Postfix uses *after* milter, never
  directly on the network.
- [`verify-pipeline.sh`](verify-pipeline.sh) — runs the receive path
  with a test mail and asserts the header appears.

## Invariants these configs enforce

1. No mail reaches the mailbox without passing the Rspamd milter.
2. Rspamd milter always adds an `Authentication-Results:` header.
3. Dovecot LMTP does not accept mail from any source other than Postfix
   local delivery (so `sieve_before` and other hooks cannot be used as
   an alternate path).
4. If the milter is unreachable, Postfix rejects the mail (550) rather
   than delivering it unfiltered (`smtpd_milters = ...` + `milter_default_action = reject`).

## What breaks if you relax any of these

- Set `milter_default_action = accept` → milter crash silently delivers
  unsanitized mail → plugin accepts it because the header *was* there on
  the previous mail and the consumer cannot distinguish.
- Add a second LMTP listener on a separate port → attacker who gets
  network access to that listener bypasses the milter entirely.
- Move `sieve_before` ahead of Rspamd → sieve script rewrites or routes
  mail before the milter stamps it.
- Enable `virtual_transport = lmtp:...` without verifying it goes
  through the same milter'd path as `local_transport` → split-brain
  delivery.

## Test after every change

Run `./verify-pipeline.sh <external-sender>` from an external host (not
localhost) and confirm the delivered message in the target mailbox
carries a well-formed `Authentication-Results:` header. Without that
header, the plugin (with default config) drops the mail and logs
`inbound dropped: authentication gate` with reason
`Authentication-Results header missing`.
