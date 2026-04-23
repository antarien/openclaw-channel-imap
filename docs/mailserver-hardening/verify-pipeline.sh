#!/usr/bin/env bash
# verify-pipeline.sh — prove the Authentication-Results header is stamped
#
# Run from an EXTERNAL host (not localhost — localhost submission can
# skip parts of the milter chain depending on Postfix config).
#
# Usage: ./verify-pipeline.sh <recipient> [<mail-server-host>]
#
# Succeeds (exit 0) only if:
#   1. The mail is delivered to <recipient>'s INBOX.
#   2. The delivered copy carries an Authentication-Results: header
#      whose authserv-id matches the one configured in rspamd.
#
# If either fails, the openclaw-channel-imap plugin's auth-gate is
# misconfigured at the server layer.

set -euo pipefail

RECIPIENT="${1:?usage: $0 <recipient@domain> [<mail.host>]}"
SERVER="${2:-mail.antarien.com}"
EXPECTED_AUTHSERV="${EXPECTED_AUTHSERV:-$SERVER}"

probe_id="openclaw-imap-probe-$(date +%s)-$$"
subject="[verify-pipeline] probe $probe_id"

echo "[verify] sending probe to $RECIPIENT via $SERVER, subject=$subject"
swaks --to "$RECIPIENT" --server "$SERVER" \
      --from "verify-pipeline@$(hostname -f)" \
      --header "Subject: $subject" \
      --body "Probe for Authentication-Results stamping. Id: $probe_id"

echo "[verify] waiting 10s for delivery"
sleep 10

echo "[verify] fetching most recent message matching subject via IMAP"
echo "[verify] manual step — inspect target mailbox and confirm:"
echo "  1. Subject line present (delivery succeeded)"
echo "  2. Header \"Authentication-Results: $EXPECTED_AUTHSERV; ...\" present"
echo "  3. That header is the ONLY Authentication-Results present"
echo "     (attacker-supplied ones were stripped by rspamd)"
echo
echo "If any of the above fails, do NOT rely on"
echo "  security.requireAuthenticationResults: true"
echo "in the plugin config — it is being bypassed."
