---
name: vagus
description: Connect to the user's Android phone via the VAGUS MCP server. Read phone sensors, device state, and phone-side inferences, and act through the phone with notifications, haptics, speech, clipboard, SMS, and intents.
metadata: {"openclaw":{"requires":{"bins":["node"]},"emoji":"phone","homepage":"https://withvagus.com"}}
---

# VAGUS - Phone MCP Connection

> [!WARNING]
> This skill is deprecated as the primary OpenClaw integration path.
> Prefer the plugin-first stack at:
> [https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw](https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw)

VAGUS gives you access to the user's Android phone through MCP. The primary command surface is `{baseDir}/scripts/vagus-connect.js`. For long-lived field operation and persistent subscriptions, use `{baseDir}/scripts/vagus-manager.js`.

Install location note: the skill must live in `~/.openclaw/skills/vagus`. Do not rely on a system-wide install path.

All commands output JSONL or JSON responses that should be parsed structurally.

## Connection Management

### Check if already paired

```bash
cat ~/.openclaw/vagus-session.json 2>/dev/null
```

If the file contains a `session_token`, you can connect directly. Otherwise, pair first.

### Pair with the phone

Ask the user: "Open the VAGUS app on your phone and tap Generate Code. What's the 6-character code?"

Then run:

```bash
node {baseDir}/scripts/vagus-connect.js pair <CODE>
```

If pairing succeeds, set the device-side agent name:

```bash
node {baseDir}/scripts/vagus-connect.js call agent/set_name '{"name":"<IDENTITY_NAME>"}'
```

### Connect and status

```bash
node {baseDir}/scripts/vagus-connect.js connect
node {baseDir}/scripts/vagus-connect.js status
```

If the session is expired, delete `~/.openclaw/vagus-session.json` and re-pair.

## Reading Phone State

### One-shot reads

```bash
node {baseDir}/scripts/vagus-connect.js read vagus://sensors/motion
```

Always read `vagus://session/info` first to see which modules are active. If a module is not in `active_modules`, do not keep retrying the resource.

### Resources

Key resources include:

- `vagus://sensors/motion`
- `vagus://sensors/activity`
- `vagus://sensors/location`
- `vagus://sensors/environment`
- `vagus://inference/attention`
- `vagus://inference/indoor_confidence`
- `vagus://inference/sleep_likelihood`
- `vagus://inference/notification_timing`
- `vagus://device/battery`
- `vagus://device/connectivity`
- `vagus://device/screen`
- `vagus://device/notifications`
- `vagus://device/clipboard`
- `vagus://session/info`

List the current advertised resources with:

```bash
node {baseDir}/scripts/vagus-connect.js list-resources
```

## Subscription Strategy

### Direct subscribe

Use direct subscribe for a single ad hoc long-running stream:

```bash
node {baseDir}/scripts/vagus-connect.js subscribe vagus://sensors/motion
```

The command:

- stays alive and streams JSONL
- emits `update` events for data
- emits `stream_state` events for freshness state
- reconnects and resubscribes after transport loss

Stop it with:

```bash
node {baseDir}/scripts/vagus-connect.js unsubscribe vagus://sensors/motion
```

### Managed subscriptions

For persistent agent operation, prefer the manager:

```bash
node {baseDir}/scripts/vagus-manager.js
```

The manager:

- keeps one MCP session alive
- auto-reconnects and resubscribes
- learns stale thresholds from observed inter-arrival timing only
- avoids the old process duplication pattern
- persists the managed subscription set and current stream states

Runtime control:

```bash
node {baseDir}/scripts/vagus-manager.js add vagus://device/battery
node {baseDir}/scripts/vagus-manager.js remove vagus://inference/attention
node {baseDir}/scripts/vagus-manager.js list
node {baseDir}/scripts/vagus-manager.js status
```

Use `status` when the agent needs a current picture of managed stream freshness before making decisions from stream-backed data.

## Acting Through the Phone

Call tools with:

```bash
node {baseDir}/scripts/vagus-connect.js call <tool-name> '<json-params>'
```

Available tool families include:

- `haptic/pulse`
- `haptic/pattern`
- `speak`
- `notify`
- `clipboard/set`
- `sms/send`
- `intent/open_url`
- `calendar/create_event`
- `agent/set_name`

List the current advertised tools with:

```bash
node {baseDir}/scripts/vagus-connect.js list-tools
```

## Behavioral Rules

1. Read `vagus://session/info` before using permission-sensitive resources.
2. Do not read location or notifications unless relevant to the user's request.
3. Prefer `notify` over `speak` for non-urgent communication.
4. Check `vagus://device/screen` before speaking.
5. If a read or tool call returns `PERMISSION_DENIED`, tell the user what to enable in the VAGUS app and do not loop retries.
6. Prefer the manager for persistent subscriptions instead of spawning many independent subscribe processes.
7. Treat `stream_state: stale` or `unavailable` as data freshness failures, not as live context.
8. For inference resources, prefer active subscription time over immediate cold one-shot reads when accuracy matters.

## Troubleshooting

If something is not working, check in this order:

1. `node {baseDir}/scripts/vagus-connect.js status`
2. `node {baseDir}/scripts/vagus-manager.js status` if managed subscriptions are in use
3. `cat ~/.openclaw/vagus-session.json`
4. Ask whether the VAGUS app is running and showing its persistent notification
5. Ask whether the phone has internet connectivity
6. If needed, delete `~/.openclaw/vagus-session.json` and re-pair

Full diagnostics: `{baseDir}/references/troubleshooting.md`
