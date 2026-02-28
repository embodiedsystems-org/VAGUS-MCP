# MCP Resources Reference

This document defines VAGUS MCP resource URIs and payload shapes returned by:

```bash
node {baseDir}/scripts/vagus-connect.js read <resource-uri>
```

Most live payloads use `ts` (epoch milliseconds). `session/info` includes ISO timestamps for connection metadata.

Subscription support:
- All resources listed in this document currently support both one-shot `read` and streaming `subscribe`/`unsubscribe`.

Module lifecycle and warm-up behavior:
- Resource modules are subscription-driven: they start when relevant subscriptions are active and may stop when subscriptions are removed.
- For inference resources (`vagus://inference/*`), stream subscriptions preserve warm state and provide better real-time accuracy.
- A one-off `read` after idle can be cold-start and may be less accurate for a short warm-up period.

## `vagus://sensors/motion`

Description: User activity and movement state.

Payload:
```json
{
  "ax": 0.38,
  "ay": -0.26,
  "az": 0.86,
  "gx": 0.89,
  "gy": 0.70,
  "gz": -0.21,
  "ts": 1771635109664
}
```

## `vagus://sensors/activity`

Description: Activity recognition state and confidence.

Payload:
```json
{
  "activity": "still",
  "confidence": 100,
  "candidates": [{ "type": "still", "confidence": 100 }],
  "registered": true,
  "last_error": null,
  "source": "gms",
  "ts": 1771635283098
}
```

## `vagus://sensors/activity_recognition`

Description: Compatibility alias for activity recognition.

Payload:
```json
{
  "activity": "still",
  "confidence": 100,
  "candidates": [{ "type": "still", "confidence": 100 }],
  "registered": true,
  "last_error": null,
  "source": "gms",
  "ts": 1771635283098
}
```

## `vagus://sensors/location`

Description: Geographic position.

Payload:
```json
{
  "latitude": 45.520275,
  "longitude": -73.5782238,
  "accuracy_m": 12.5,
  "speed_mps": 0.0,
  "altitude_m": 24.1,
  "provider": "gps",
  "ts": 1771632795842
}
```

Notes:
- `place_name` may be `null`.
- Requires location permission in VAGUS app.

## `vagus://sensors/environment`

Description: Inferred environment context from ambient sensors, activity, connectivity, and time.

Payload:
```json
{
  "context": "indoor|outdoor|vehicle|unknown",
  "confidence": 0.0,
  "raw_context": "indoor|outdoor|vehicle|unknown",
  "raw_confidence": 0.65,
  "activity": "still|walking|running|in_vehicle|cycling|unknown",
  "activity_confidence": 100,
  "light_lux": 320.0,
  "pressure_hpa": 1013.2,
  "proximity_cm": 5,
  "transport": "wifi|cellular|none",
  "evidence": ["activity=still", "light=dim", "transport=wifi", "time=night"],
  "ts": 1771632371930
}
```

Notes:
- `context` is debounced/stabilized inference.
- `raw_context`/`raw_confidence` represent immediate classifier output before hysteresis.

## `vagus://inference/attention`

Description: Attention availability inferred from screen/lock state, activity, charging, and local time.

Payload:
```json
{
  "availability": "available|busy|away|unknown",
  "confidence": 0.85,
  "screen_on": true,
  "locked": false,
  "activity": "still|walking|running|in_vehicle|cycling|unknown",
  "charging": true,
  "hour_local": 23,
  "evidence": ["activity=still", "charging=true"],
  "ts": 1771648591872
}
```

## `vagus://inference/indoor_confidence`

Description: Indoor probability inferred from ambient sensors, connectivity, and activity.

Payload:
```json
{
  "indoor_probability": 0.689441,
  "label": "likely_indoor|likely_outdoor|unknown",
  "confidence": 0.37888205,
  "light_lux": 0.9,
  "proximity_cm": 5,
  "transport": "wifi|cellular|none",
  "activity": "still|walking|running|in_vehicle|cycling|unknown",
  "evidence": ["light=dim", "transport=wifi", "activity=still", "night+low_light"],
  "ts": 1771648857006
}
```

## `vagus://inference/sleep_likelihood`

Description: Sleep likelihood inferred from time, screen/lock state, activity, light, and charging.

Payload:
```json
{
  "sleep_probability": 0.70000005,
  "label": "low|medium|high",
  "screen_on": true,
  "locked": false,
  "activity": "still|walking|running|in_vehicle|cycling|unknown",
  "light_lux": 0.90000004,
  "charging": true,
  "hour_local": 23,
  "evidence": ["time=sleep_window", "activity=still", "light=very_low", "charging=true"],
  "ts": 1771649038797
}
```

## `vagus://inference/notification_timing`

Description: Notification timing suitability inferred from attention, sleep likelihood, activity, and context.

Payload:
```json
{
  "suitability": 0.59999996,
  "label": "good|neutral|poor",
  "sleep_probability": 0.70000005,
  "screen_on": true,
  "locked": false,
  "activity": "still|walking|running|in_vehicle|cycling|unknown",
  "transport": "wifi|cellular|none",
  "metered": false,
  "hour_local": 23,
  "evidence": ["screen=interactive", "activity=still", "time=quiet_window", "sleep=medium", "transport=wifi"],
  "ts": 1771649281135
}
```

## `vagus://device/battery`

Description: Battery and charging state.

Payload:
```json
{
  "percent": 93,
  "charging": true,
  "ts": 1771624247736
}
```

## `vagus://device/connectivity`

Description: Current network status.

Payload:
```json
{
  "connected": true,
  "transport": "wifi|cellular|none",
  "validated": true,
  "metered": false,
  "roaming": false,
  "carrier": "Example Carrier",
  "ts": 1771632795842
}
```

## `vagus://device/screen`

Description: Screen and lock state.

Payload:
```json
{
  "screen_on": true,
  "locked": false,
  "last_event": "init|on|off|locked|unlocked",
  "ts": 1771633276167
}
```

## `vagus://device/notifications`

Description: Incoming app notifications.

Payload:
```json
{
  "listener_enabled": true,
  "events": [
    {
      "event": "posted",
      "package": "com.example.app",
      "title": "New message",
      "body": "You have 1 unread message",
      "ts": 1771633779376
    }
  ],
  "ts": 1771633779376
}
```

Notes:
- Requires notification-read permission in VAGUS app.

## `vagus://device/clipboard`

Description: Current clipboard content.

Payload:
```json
{
  "content": "https://example.com/article",
  "ts": 1771631929368
}
```

Notes:
- Requires clipboard-read permission in VAGUS app.

## `vagus://session/info`

Description: Session metadata and active capability modules.

Payload:
```json
{
  "active_modules": [
    "motion",
    "environment",
    "battery",
    "connectivity",
    "screen",
    "haptics",
    "tts"
  ],
  "active_module_ids": ["motion", "environment", "battery", "connectivity"],
  "active_modules_pretty": ["motion", "environment", "battery", "connectivity"],
  "io_sensors": [{ "id": "io/type_2", "enabled": true }],
  "agent_name": "Test Agent",
  "device_model": "VOG-L04",
  "android_version": 29,
  "connected_since": "2026-02-20T14:20:00.000Z",
  "vagus_version": "1.0.0"
}
```

## Subscription Notifications

Subscription updates are emitted as JSONL:

```json
{"type":"update","uri":"vagus://sensors/motion","data":{...}}
```

Reconnect and gap replay behavior:
- On disconnect, server tracks disconnect start time.
- On reconnect (after client `initialized`), server emits:

```json
{"type":"session_reconnect","sessionId":"...","gap_ms":1234,"ts":1771650000000}
```

- For each active subscription (or re-subscription) after reconnect:
1. server replays buffered updates for that resource since the disconnect window (bounded up to last 64 updates)
2. server emits one fresh current-state snapshot for that resource
3. server continues normal live `update` streaming

Use:
```bash
node {baseDir}/scripts/vagus-connect.js subscribe <resource-uri>
node {baseDir}/scripts/vagus-connect.js unsubscribe <resource-uri>
```
