# VAGUS Relay Server (Step 1)

Node.js WebSocket pairing relay for the VAGUS MCP transport.

## Deploy Target

- Example relay URL: `wss://relay.example.com`
- App default relay base URL: `wss://relay.example.com`

## Endpoints

- `POST /pair` with body `{ "code": "ABC123" }`
- `POST /revoke` with body `{ "session_token": "..." }` (idempotent)
- `WSS /connect/{session_token}`
  - App should connect as `wss://.../connect/{session_token}?role=app`
  - Clients connect without `role` (defaults to `client`)
- `GET /health`

## Behavior

- Pair codes expire after 15 minutes by default.
- Session token rotates for each new pairing reservation.
- Session state can be persisted in Redis so relay restarts do not force re-pair.
- Max message size is 1 MB.
- Messages are forwarded in memory only and are not persisted.
- Role-aware routing: one `app` socket and many concurrent `client` sockets per session.
- Client requests are multiplexed by relay with internal JSON-RPC id remapping.
- App responses are demultiplexed back to the originating client.
- App notifications are broadcast to all connected clients in the session.
- If app disconnects, connected clients are closed and must reconnect.
- Short transient gaps are buffered in-memory (bounded) and flushed on reconnect.
- Session token is kept until TTL for reconnect.

## Run

```bash
npm install
npm start
```

Defaults:

- `PORT=18087`
- `PAIR_TTL_MS=900000`
- `SESSION_TTL_MS=0` (0 = no expiry after a pair has completed)
- `MAX_MESSAGE_BYTES=1048576`
- `TRUST_PROXY=true` (recommended behind nginx)
- `REQUIRE_ORIGIN=false` (allows native clients without `Origin` header)
- `REDIS_URL=` (empty = in-memory only)
- `REDIS_PREFIX=vagus:relay:`
- `REQUIRE_REDIS=false` (set `true` in production)

## Production Deploy (VPS)

Target domain: `wss://relay.example.com`

1. Provision on VPS:
```bash
sudo mkdir -p <relay_root>
sudo chown -R $USER:$USER <relay_root>
```
2. Copy `relay-server/` contents to `<relay_root>`.
3. Install dependencies:
```bash
cd <relay_root>
npm install --omit=dev
```
4. Configure env from `.env.example` (or systemd `EnvironmentFile`).
  - For production-safe restarts, configure Redis:
    - `REDIS_URL=<redis_url>`
    - `REQUIRE_REDIS=true`
5. Choose a process manager:
- `systemd`: use `deploy/systemd/vagus-relay.service`
- `pm2`: use `ecosystem.config.cjs`
6. Install nginx config:
- Copy `deploy/nginx/relay.example.com.conf (rename to match your domain if desired)` to `/etc/nginx/sites-available/`
- Enable site and reload nginx.
- Ensure TLS cert files exist for `relay.example.com`.
7. Verify:
```bash
curl -sS https://relay.example.com/health
node scripts/smoke-test.js
```

Expected `/health` fields now include:
- `mode: "multi-client"`
- `relay_build` (from env `RELAY_BUILD`)
- `persistence: "redis"` (production target)

## Security Controls Included

- In-memory only message relay (no payload persistence)
- Pairing code TTL and session cleanup
- Max body/message size caps
- Per-IP `/pair` rate limiting
- Optional WS origin allowlist (`ORIGIN_ALLOWLIST`)
- Optional strict origin requirement (`REQUIRE_ORIGIN=true`)
- Optional CORS for browser pairing calls (`CORS_ALLOW_ORIGIN`)
- Graceful shutdown and connection cleanup
- Optional Redis-backed persistent pairing/session state (`REDIS_URL`)


