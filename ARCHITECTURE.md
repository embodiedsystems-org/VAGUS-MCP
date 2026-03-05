# Architecture

## Components

1. `relay-server`
- Stateless WebSocket relay with optional Redis-backed session persistence.
- Handles pairing (`POST /pair`), revocation (`POST /revoke`), health (`GET /health`), and WebSocket upgrades (`/connect/{session_token}`).

2. `vagus-openclaw` (legacy, deprecated)
- OpenClaw skill package and CLI (`scripts/vagus-connect.js`) for pairing, MCP initialization, resource reads, subscriptions, and tool calls.
- Stores client session state in `~/.openclaw/vagus-session.json`.
- Replaced for primary OpenClaw runtime integration by native plugins in:
  [Somatic Memory for OpenClaw](https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw)

3. `docs`
- Static HTML/CSS/JS documentation site for deployment and integration guidance.

## Session Flow

1. User obtains 6-character pairing code from the phone app.
2. Client sends code to relay `POST /pair`.
3. Relay returns `session_token`.
4. App and client connect to `wss://<relay>/connect/<session_token>`.
5. Relay routes JSON-RPC MCP traffic:
- client requests -> app (with internal id remapping)
- app responses -> originating client
- app notifications -> broadcast or per-session routing

## Data and Trust Boundaries

- Relay does not persist payload bodies by design; it forwards messages in memory.
- Pair/session metadata may be persisted in Redis when configured.
- Client-side token persistence is local to the OpenClaw host user profile.

## Operational Notes

- `TRUST_PROXY`, CORS, and origin validation are configurable on relay.
- Redis is optional by default and recommended for production continuity.
- See [relay-server/README.md](./relay-server/README.md) for deployment controls.
- For OpenClaw runtime integration, use the plugin-first path in:
  [Somatic Memory for OpenClaw](https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw)
