# VAGUS MCP

Monorepo for the VAGUS MCP stack:
- `relay-server/`: WebSocket pairing and transport relay
- `vagus-openclaw/`: Legacy OpenClaw skill and Node CLI client (deprecated)
- `docs/`: static developer documentation site
- `releases/`: distributable Android build artifacts (including RC APKs)
- `ROADMAP.md`: product and platform roadmap

## Repository Layout

```text
.
├── docs/
├── releases/
├── relay-server/
├── vagus-openclaw/ (deprecated)
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

Legacy path (deprecated):

```bash
cd vagus-openclaw/scripts
npm install
node vagus-connect.js pair <PAIR_CODE>
node vagus-connect.js status
```

Recommended path (plugin-first):

- Use Somatic Memory native OpenClaw plugins from the repository root:
  [Somatic Memory for OpenClaw](https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw)

### 3) Open static docs

Open [docs/index.html](./docs/index.html) in a browser, or serve `docs/` with any static file server.

## Deployment

- Relay production docs: [relay-server/README.md](./relay-server/README.md)
- Legacy OpenClaw skill docs (deprecated): [vagus-openclaw/README.md](./vagus-openclaw/README.md)
- Plugin-first OpenClaw integration: [Somatic Memory for OpenClaw](https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw)
- Upload prep: [PUBLISHING_CHECKLIST.md](./PUBLISHING_CHECKLIST.md)

## Releases

Current RC artifact in `releases/`:
- `vagusmcp-0.9.0-rc.1.apk`

## Security

Please read [SECURITY.md](./SECURITY.md) before publishing or deploying.
