# VAGUS Roadmap

> The embodiment layer is getting deeper.

This roadmap tracks what's coming to VAGUS Core. Features are grouped by what they unlock — not just what they do.

Status key: `🟢 in progress` · `🔵 planned` · `⚪ exploring`

---

## More Integrations

### 🟢 Official n8n Integration
An official integration with n8n MCP client will be released shortly. 




---

## The agent becomes self-aware

### 🟢 Agent Log Read Tool
The agent can currently act — but it can't review what it's done. This adds a tool that lets the agent read its own access logs: what it sensed, what it inferred, what actions it took, and when.

**Why it matters:** Self-referential access is a prerequisite for agents that learn from their own embodied behavior. An agent that can review its interaction history can self-correct, build context across sessions, and reason about its own patterns.

**MCP surface:** `logs/read` — tool returning structured log entries with timestamps, capability type, and payloads.

---

## The body expands beyond the phone

### 🔵 Bluetooth Sensor Pairing (Wearables, Smart Glasses)
VAGUS currently uses the phone's built-in sensors. Bluetooth pairing extends the sensory surface to external hardware — heart rate monitors, smart rings, smart glasses, environmental sensors, or any BLE-capable device.

**Why it matters:** This is how the agent's body grows. A phone in your pocket gives motion and location. A ring gives heart rate. Glasses give visual context. Each paired device adds a new sensory dimension — the agent perceives more of the world without the user describing it.

**MCP surface:** New resources under `vagus://bluetooth/*` — dynamically registered as devices pair. Capability negotiation discovers what each device exposes.

---

## Intelligence moves to the edges

### 🔵 External Inference Pipelines
Currently, all inference runs on-device as built-in heuristics. External inference pipelines allow the inference layer to call out to external services — cloud ML models, custom classifiers, user-hosted pipelines — and expose results as standard inference resources.

**Why it matters:** On-device heuristics are fast and private but limited. External pipelines open the inference layer to arbitrarily sophisticated processing: emotion detection, health pattern recognition, complex activity classification, custom models trained on personal data. The agent's understanding becomes extensible without changing the app.

**Architecture:** Inference resources remain the same MCP interface. The pipeline behind them becomes pluggable — local heuristic, cloud API, or user-hosted model. The agent doesn't know or care which.

---

## Governance gets granular

### 🔵 Granular Governance on Inference
Individual inference channels already have on/off toggles. This extends the full governance stack — rate limits, time-of-day windows, "ask each time" approval, and per-channel audit logs — to each inference resource independently.

**Why it matters:** Inference is where raw signals become meaning. Being able to toggle channels is a start, but real governance means controlling *how often* the agent checks your sleep state, *when* it's allowed to assess your attention, and having a reviewable log of every inference it made. The same depth of control that exists for sensors and I/O tools, now applied to the meaning layer.

---

## Multiple agents, one body

### 🔵 Multi-Agent Support
Right now VAGUS pairs with one agent at a time. Multi-agent support lets multiple agents connect to the same device simultaneously — each with its own identity, permissions, and governance scope. The phone becomes a shared body with individually governed tenants.

**Why it matters:** The session and subscription architecture already tracks per-session IDs internally. This surfaces that as a first-class capability: concurrent connections, per-agent governance profiles, per-agent audit logs, and priority/conflict resolution when two agents try to act on the same output channel. Agent identity via `agent/set_name` becomes critical — the user sees who's asking for what.

---

## The sensor layer opens up

### ⚪ Sensor API Export
Bridge phone sensors to callable Web Sensor APIs. External services — your own inference pipelines, logging dashboards, research tools, third-party processors — can subscribe to VAGUS sensor streams over standard web APIs without going through MCP.

**Why it matters:** Right now, sensor data flows exclusively through the MCP channel to the connected agent. Sensor API Export creates a parallel path — the same sensor streams, accessible over HTTP/WebSocket to any web service. This enables real-time logging, parallel inference processing, multi-consumer architectures, and integration with existing sensor analytics tooling. The phone becomes a general-purpose sensor hub, not just an agent endpoint.

---

### ⚪ External Web Sensor API Ingestion
Connect external web sensor APIs — weather services, air quality feeds, smart home platforms, health APIs, any REST/WebSocket data source — to MCP so agents can access them as standard VAGUS resources.

**Why it matters:** The agent's sensory world shouldn't be limited to what's physically on the phone. External API ingestion lets you register any web data source as a VAGUS resource. A weather API becomes `vagus://external/weather`. A smart home hub becomes `vagus://external/home_temperature`. The agent discovers and reads them the same way it reads the accelerometer — through MCP capability negotiation. The sensory surface becomes unbounded.

---

[withvagus.com](https://withvagus.com) · [docs.withvagus.com](https://docs.withvagus.com) · [vagusmcp@gmail.com](mailto:vagusmcp@gmail.com)
