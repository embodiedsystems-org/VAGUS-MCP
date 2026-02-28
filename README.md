# VAGUS MCP

Monorepo for the VAGUS MCP stack:
- `relay-server/`: WebSocket pairing and transport relay
- `vagus-openclaw/`: OpenClaw skill and Node CLI client
- `docs/`: static developer documentation site
- `releases/`: distributable Android build artifacts (including RC APKs)
- `ROADMAP.md`: product and platform roadmap

## Repository Layout

```text
.
├── docs/
├── releases/
├── relay-server/
├── vagus-openclaw/
├── ROADMAP.md
├── ARCHITECTURE.md
└── SECURITY.md
```

## Quick Start

### 1) Run the relay server

```bash
cd relay-server
npm install
npm start
```

### 2) Run the OpenClaw client locally

```bash
cd vagus-openclaw/scripts
npm install
node vagus-connect.js pair <PAIR_CODE>
node vagus-connect.js status
```

### 3) Open static docs

Open [docs/index.html](./docs/index.html) in a browser, or serve `docs/` with any static file server.

## Deployment

- Relay production docs: [relay-server/README.md](./relay-server/README.md)
- OpenClaw skill docs: [vagus-openclaw/README.md](./vagus-openclaw/README.md)
- Upload prep: [PUBLISHING_CHECKLIST.md](./PUBLISHING_CHECKLIST.md)

## Releases

Current RC artifact in `releases/`:
- `vagusmcp-0.9.0-rc.1.apk`

## Security

Please read [SECURITY.md](./SECURITY.md) before publishing or deploying.
