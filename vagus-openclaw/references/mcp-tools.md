# MCP Tools Reference

This document defines VAGUS MCP tools called via:

```bash
node {baseDir}/scripts/vagus-connect.js call <tool-name> '<json-params>'
```

Success shape:
```json
{"type":"result","tool":"<tool-name>","success":true,"data":{...}}
```

Failure shape:
```json
{"type":"result","tool":"<tool-name>","success":false,"error":"<CODE>","message":"..."}
```

## `haptic/pulse`

Description: Single vibration pulse.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "durationMs": { "type": "integer", "minimum": 10, "maximum": 5000 }
  },
  "additionalProperties": false
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call haptic/pulse '{"durationMs":200}'
```

## `haptic/pattern`

Description: Custom vibration pattern.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "array",
      "items": { "type": "integer", "minimum": 0 }
    }
  },
  "additionalProperties": false
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call haptic/pattern '{"pattern":[0,120,80,120]}'
```

## `speak`

Description: Text-to-speech through phone speaker.

Input schema:
```json
{
  "type": "object",
  "required": ["text"],
  "properties": {
    "text": { "type": "string", "maxLength": 5000 },
    "language": { "type": "string", "description": "BCP-47 tag, e.g. en-US" },
    "rate": { "type": "number", "minimum": 0.25, "maximum": 2.0 },
    "pitch": { "type": "number", "minimum": 0.5, "maximum": 2.0 },
    "interrupt": { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call speak '{"text":"You have a meeting in 10 minutes"}'
```

## `notify`

Description: Push notification on phone.

Input schema:
```json
{
  "type": "object",
  "required": ["title", "body"],
  "properties": {
    "title": { "type": "string", "maxLength": 200 },
    "body": { "type": "string", "maxLength": 1000 }
  },
  "additionalProperties": false
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call notify '{"title":"Reminder","body":"Check your email"}'
```

## `clipboard/set`

Description: Write text to phone clipboard.

Input schema:
```json
{
  "type": "object",
  "required": ["content"],
  "properties": {
    "content": { "type": "string", "maxLength": 10000 }
  },
  "additionalProperties": false
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call clipboard/set '{"content":"https://example.com"}'
```

## `sms/send`

Description: Send an SMS message to a phone number.

Input schema:
```json
{
  "type": "object",
  "required": ["to", "body"],
  "properties": {
    "to": {
      "type": "string",
      "description": "Phone number in local or E.164 format"
    },
    "body": { "type": "string", "maxLength": 2000 }
  }
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call sms/send '{"to":"+15145551212","body":"Running 10 minutes late"}'
```

## `intent/open_url`

Description: Open a URL in a browser.

Input schema:
```json
{
  "type": "object",
  "required": ["url"],
  "properties": {
    "url": {
      "type": "string",
      "description": "http/https URL to open"
    }
  }
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call intent/open_url '{"url":"https://withvagus.com"}'
```

## `calendar/create_event`

Description: Create a calendar event on the device.

Input schema:
```json
{
  "type": "object",
  "required": ["title"],
  "properties": {
    "title": { "type": "string", "maxLength": 200 },
    "startTimeMs": { "type": "integer", "description": "Unix epoch milliseconds" },
    "endTimeMs": { "type": "integer", "description": "Unix epoch milliseconds" },
    "location": { "type": "string", "maxLength": 200 },
    "description": { "type": "string", "maxLength": 2000 },
    "allDay": { "type": "boolean" }
  }
}
```

Example:
```bash
node {baseDir}/scripts/vagus-connect.js call calendar/create_event '{"title":"Team Sync","startTimeMs":1771693200000,"endTimeMs":1771696800000,"location":"Zoom","description":"Weekly planning","allDay":false}'
```

## `agent/set_name`

Description: Set (or clear) the device-side agent identity name shown in session metadata.

Input schema:
```json
{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name": { "type": "string", "maxLength": 64 }
  },
  "additionalProperties": false
}
```

Example (set):
```bash
node {baseDir}/scripts/vagus-connect.js call agent/set_name '{"name":"OpenClaw"}'
```

Example (clear):
```bash
node {baseDir}/scripts/vagus-connect.js call agent/set_name '{"name":""}'
```

## Permission-Related Errors

Common tool-level failures:
- `PERMISSION_DENIED`: capability disabled in VAGUS app
- `CALL_FAILED`: request failed or timed out

Agent behavior:
- Explain which capability is required.
- Do not retry repeatedly.
