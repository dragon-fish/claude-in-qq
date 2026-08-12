---
name: configure
description: Set up the QQ channel — run the scan-to-configure flow or save credentials by hand, and review channel status. Use when the user asks to configure QQ, wants to connect a QQ bot, asks "how do I set this up", or wants to check whether the QQ channel is ready.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
  - Bash(bun run *)
---

# /qq:configure — QQ Channel Setup

Provisions credentials for the QQ channel and reports where setup stands.
State lives in `~/.claude/channels/qq/`; the server reads it at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and next step

1. **Credentials** — check `~/.claude/channels/qq/.env` for `QQ_APP_ID` and
   `QQ_CLIENT_SECRET`. Report set / not set. Show the app id; **never print the
   secret**, not even partially.
2. **Allowlist** — read `~/.claude/channels/qq/access.json` (missing file means
   nobody is allowed, which is the safe default). Report the policy and how
   many openids are allowed.
3. **Next step** — one concrete instruction:
   - No credentials → *"Run `/qq:configure scan` and open the link on your
     phone."*
   - Credentials set, allowlist empty → *"Message the bot from QQ, then approve
     the pairing code with `/qq:access pair <code>`."*
   - Both set → *"Ready. Start Claude Code with
     `claude --dangerously-load-development-channels server:qq` and message the
     bot from QQ."*

### `scan` — scan-to-configure (preferred)

Run the onboarding flow from the plugin directory:

```
bun run onboard.ts
```

It prints a `CONNECT_URL:` line and, when a terminal is attached, a QR code.
Tell the user to either scan the QR with the QQ app or open that URL on their
phone. QQ provisions the bot application on Tencent's side, so there is no
form to fill in at q.qq.com.

On success the flow writes `QQ_APP_ID` / `QQ_CLIENT_SECRET` to `.env` (mode
600) and adds the scanner's openid to the allowlist — the person who scans is
the operator, so no separate pairing step is needed.

Afterwards, tell the user the session must be restarted for the server to pick
up the new credentials.

### `<app_id> <secret>` — save credentials by hand

The fallback for when the scan flow is unavailable — the `/lite/*` endpoints it
uses are not part of the published QQ Bot API and can change. In that case the
user registers an application at <https://q.qq.com> and passes the pair here.

1. `mkdir -p ~/.claude/channels/qq`
2. Read the existing `.env` if present; replace the `QQ_APP_ID=` and
   `QQ_CLIENT_SECRET=` lines, preserving any other keys. No quotes around values.
3. `chmod 600 ~/.claude/channels/qq/.env`
4. Confirm without echoing the secret, then show the no-args status.

### `clear` — remove credentials

Delete the `QQ_APP_ID` and `QQ_CLIENT_SECRET` lines, or the file when they are
the only contents. Leave `access.json` alone; removing credentials is not a
reason to discard the allowlist.

---

## Implementation notes

- `.env` is read once at server boot. Credential changes need a session restart.
- `access.json` is re-read on every inbound message, so `/qq:access` changes
  take effect immediately.
- A missing state directory means "not configured yet", not an error.
- The bot shows as offline in QQ whenever the channel server is not running.
  That is expected, not a fault to debug.
