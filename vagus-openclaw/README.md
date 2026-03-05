# VAGUS Skill for OpenClaw

Give your OpenClaw agent a phone.

> [!WARNING]
> `vagus-openclaw` is deprecated and retained only as a legacy compatibility path.
> Use the plugin-first integration at the Somatic Memory repository root:
> [https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw](https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw)
>
> See deprecation details in [DEPRECATED.md](./DEPRECATED.md).

## Install

Install the skill to your user OpenClaw skills directory so it survives updates. Do not place it in the system skills directory.

### Manual Install

From the skill root:

```bash
./scripts/install.sh
```

This copies the skill to `~/.openclaw/skills/vagus` and installs dependencies.

Manual alternative:

```bash
mkdir -p ~/.openclaw/skills
git clone https://github.com/vagus-mcp/openclaw-skill.git ~/.openclaw/skills/vagus
cd ~/.openclaw/skills/vagus/scripts
npm install
```

After install:

```bash
node vagus-connect.js pair <CODE>
node vagus-connect.js call agent/set_name '{"name":"<YOUR_AGENT_NAME>"}'
```

## Requirements

- VAGUS app installed on an Android phone
- OpenClaw with Node 22+
- Internet access to `relay.withvagus.com`

## What It Does

Once connected, your agent can:

- Read phone sensors: motion, location, environment
- Read inferred attention availability, indoor confidence, sleep likelihood, and notification timing
- Read device state: battery, connectivity, screen
- Read phone notifications if enabled
- Call haptics, speech, notifications, clipboard, SMS, URL intent, calendar, and `agent/set_name`

Capabilities are controlled by the user through VAGUS app permission toggles.

## Repository Structure

```text
.
|-- SKILL.md
|-- scripts/
|   |-- package.json
|   |-- vagus-connect.js
|   |-- vagus-manager.js
|   `-- lib/
|       |-- adaptive-freshness.js
|       |-- managed-subscription-session.js
|       |-- mcp-codec.js
|       |-- mcp-session.js
|       |-- session-store.js
|       |-- subscription-manager.js
|       `-- ws-transport.js
|-- references/
|   |-- mcp-resources.md
|   |-- mcp-tools.md
|   `-- troubleshooting.md
`-- README.md
```

## Pairing and Diagnostics

```bash
cd ~/.openclaw/skills/vagus/scripts
npm install
node vagus-connect.js pair <CODE>
node vagus-connect.js status
node vagus-connect.js read vagus://session/info
node vagus-connect.js list-resources
node vagus-connect.js list-tools
```

## Subscription Modes

### Direct Subscribe

Use this when the agent wants a single long-running stream:

```bash
node vagus-connect.js subscribe <resource-uri>
```

Behavior:

- The command is long-running and writes JSONL to stdout.
- It emits `update` events for new data.
- It also emits `stream_state` events so the agent can detect `warming`, `grace`, `fresh`, `delayed`, `stale`, and `unavailable`.
- It survives transport loss by reconnecting, reinitializing MCP, and resubscribing the active URI.
- Stop it by terminating the process or calling:

```bash
node vagus-connect.js unsubscribe <resource-uri>
```

### Managed Subscriptions

For long-lived field operation, prefer the manager:

```bash
node vagus-manager.js
```

The manager keeps one MCP session alive, auto-reconnects, resubscribes after transport loss, tracks adaptive freshness per stream, persists the managed subscription set, and avoids the old multi-process duplication failure mode.

Runtime control:

```bash
node vagus-manager.js add vagus://device/battery
node vagus-manager.js remove vagus://inference/attention
node vagus-manager.js list
node vagus-manager.js status
```

Manager behavior:

- One shared WebSocket/MCP session instead of one process per resource
- Singleton startup protection
- Cleanup of legacy per-resource PID files on startup
- Dynamic stale thresholds learned only from observed inter-arrival timing
- State persisted to `scripts/pid/vagus-manager.state.json`
- Lifecycle output in `scripts/logs/manager.out`
- Per-resource update and state logs in `scripts/logs/*.log`

## Notes

- Module lifecycle is subscription-driven.
- Inference resources are most accurate while actively subscribed.
- On reconnect, the server emits `session/reconnect`, replays bounded buffered updates, then emits a fresh snapshot before normal live streaming resumes.

## Troubleshooting

Start with:

```bash
node {baseDir}/scripts/vagus-connect.js status
```

Then follow `references/troubleshooting.md`.
