"use strict";

const WebSocket = require("ws");

async function main() {
  const baseHttps = process.env.RELAY_BASE_HTTPS || "https://relay.example.com";
  const baseWss = process.env.RELAY_BASE_WSS || "wss://relay.example.com";
  const code = "SMK" + Math.floor(Math.random() * 1000).toString().padStart(3, "0");

  const healthRes = await fetch(`${baseHttps}/health`);
  if (!healthRes.ok) {
    throw new Error(`health failed: ${healthRes.status}`);
  }
  const health = await healthRes.json();

  const pairRes = await fetch(`${baseHttps}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code })
  });
  if (!pairRes.ok) {
    throw new Error(`pair failed: ${pairRes.status}`);
  }
  const pair = await pairRes.json();
  const token = pair.session_token;
  if (!token) {
    throw new Error("pair response missing session_token");
  }

  const a = new WebSocket(`${baseWss}/connect/${token}`);
  const b = new WebSocket(`${baseWss}/connect/${token}`);

  await new Promise((resolve, reject) => {
    let openCount = 0;
    let done = false;

    const timeout = setTimeout(() => {
      finish(new Error("timeout waiting for WS echo"));
    }, 5000);

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try {
        a.close();
      } catch {}
      try {
        b.close();
      } catch {}
      if (err) reject(err);
      else resolve();
    }

    function onOpen() {
      openCount += 1;
      if (openCount === 2) {
        a.send("ping");
      }
    }

    a.on("open", onOpen);
    b.on("open", onOpen);

    a.on("error", (err) => finish(err));
    b.on("error", (err) => finish(err));

    b.on("message", (message) => {
      const text = String(message);
      if (text !== "ping") {
        finish(new Error(`unexpected payload: ${text}`));
        return;
      }
      finish();
    });
  });

  console.log(
    JSON.stringify({
      ok: true,
      health,
      code,
      token_prefix: token.slice(0, 8)
    })
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});

