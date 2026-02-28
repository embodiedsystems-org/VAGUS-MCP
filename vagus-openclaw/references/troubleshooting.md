# VAGUS Troubleshooting Guide

Use this checklist when VAGUS commands fail or return incomplete data.

## 0. Verify Skill Installation Location

**Important:** The skill must be installed in your user OpenClaw skills directory: `~/.openclaw/skills/vagus`.

Do NOT use `/usr/local/lib/node_modules/openclaw/skills/vagus` or other system paths, as they may be removed during OpenClaw updates, causing "command not found" or subscription failures.

Check:
```bash
ls ~/.openclaw/skills/vagus/scripts/vagus-connect.js
```

If missing, reinstall using `./scripts/install.sh` from the skill repo.

## 1. Check Session Status

Run:
```bash
node {baseDir}/scripts/vagus-connect.js status
```

Interpretation:
- `connected: true`: session is active; continue to permission/capability checks.
- `connected: false` with `reason: "no_session"`: no session token exists; run pair flow.
- `connected: false` with `last_error`: connection or handshake problem; continue below.

## 2. Verify Session Token File

Run:
```bash
cat ~/.openclaw/vagus-session.json 2>/dev/null
```

Expected:
- Valid JSON including `session_token`.

If missing or invalid:
- Re-pair with a fresh code:
```bash
node {baseDir}/scripts/vagus-connect.js pair <CODE>
```

If token appears stale:
- Delete and re-pair:
```bash
rm ~/.openclaw/vagus-session.json
node {baseDir}/scripts/vagus-connect.js pair <CODE>
```

## 3. Confirm App Is Running

Ask user to verify on phone:
- VAGUS app is open or running in foreground service mode.
- Persistent VAGUS notification is visible.
- Internet is available on phone.

## 4. Confirm Host Connectivity to Relay

Relay endpoint:
- `wss://relay.withvagus.com`
- Pair endpoint: `https://relay.withvagus.com/pair`

If host cannot reach relay, pairing and connect commands will fail.

## 5. Diagnose Common Error Codes

## `PAIR_FAILED`
- Cause: invalid/expired pairing code, relay unavailable, or app not ready.
- Action: generate new code in app, ensure app is running, retry pair.

## `SESSION_EXPIRED`
- Cause: saved token rejected (401/403).
- Action: delete `~/.openclaw/vagus-session.json`, request new pairing code, run pair again.

## `NO_SESSION`
- Cause: no saved session file.
- Action: run `pair <CODE>`.

## `READ_FAILED`
- Cause: invalid URI, capability not active, permission denied, or connection issue.
- Action:
1. Read `vagus://session/info`.
2. Verify requested module appears in `active_modules`.
3. Ask user to enable permission in VAGUS app.

## `CALL_FAILED` or tool result `success:false`
- Cause: invalid tool params, permission denied, or runtime failure.
- Action:
1. Validate JSON params against `references/mcp-tools.md`.
2. Check capability permissions in VAGUS app.
3. Retry once after confirming session health.

## `BAD_JSON`
- Cause: malformed JSON string passed to `call`.
- Action: fix quoting and JSON syntax.

## 6. Capability/Permission Mismatch

Before reading resources or calling tools, fetch:
```bash
node {baseDir}/scripts/vagus-connect.js read vagus://session/info
```

If a module is not active:
- Do not retry repeatedly.
- Tell user exactly which permission/capability to enable in VAGUS app.

## 7. Quick Validation Sequence

Use this order for recovery:
1. `status`
2. `read vagus://session/info`
3. `list-resources`
4. `list-tools`
5. one known-safe tool call (e.g. `notify`)

## 8. Escalation Notes

Collect for debugging:
- command run
- raw JSONL output
- timestamp
- session status output
- whether app was running and networked
