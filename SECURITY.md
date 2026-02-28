# Security Policy

## Supported Components

- `relay-server`
- `vagus-openclaw`
- `docs` (documentation-only surface)

## Reporting a Vulnerability

Please report security issues privately to:
- `vagusmcp@gmail.com`

Include:
1. Affected component and file path(s)
2. Reproduction steps
3. Impact assessment
4. Suggested fix (if available)

Do not open public issues for unpatched vulnerabilities.

## Secure Deployment Baseline

For production relay deployments:
1. Use TLS termination and HTTPS/WSS only.
2. Set `TRUST_PROXY=true` only behind a trusted reverse proxy.
3. Configure origin controls (`ORIGIN_ALLOWLIST`, `REQUIRE_ORIGIN`) where browser access is expected.
4. Use Redis-backed persistence when restart continuity is required.
5. Rotate and revoke session tokens when compromise is suspected.
6. Keep Node.js runtime and dependencies current.
