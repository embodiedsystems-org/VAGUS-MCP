# `vagus-openclaw` Deprecation Notice

`vagus-openclaw` is deprecated as the primary OpenClaw integration path.

## Status

- This package is legacy and maintained only for migration compatibility.
- New runtime behavior should not be added here.
- The recommended integration is the native plugin-first stack at:
  [https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw](https://github.com/embodiedsystems-org/Somatic-Memory-for-Openclaw)

## Migration Direction

- Use `vagus-core` as the transport/session owner.
- Use `somatic-memory` as the memory ingestion/recall layer.
- Keep this package only as a temporary fallback during cutover.
