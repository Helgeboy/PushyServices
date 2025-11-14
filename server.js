// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Faye = require("faye");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ------------------------------------------------------------------
// Environment
// ------------------------------------------------------------------
const {
  PODIO_CLIENT_ID,             // (not used by push, but kept for future OAuth needs)
  PODIO_CLIENT_SECRET,         // (not used by push, but kept for future OAuth needs)
  PODIO_COMETD_URL = "https://podio.com:443/cometd", // Set to the correct Podio CometD endpoint per docs
  AVA_TOPIC_URL,
  DEBUG_WEBHOOK_URL,
  NODE_ENV = "production",
  LOG_LEVEL = "info"
} = process.env;

const PORT = process.env.PORT || 8080;

// ------------------------------------------------------------------
// Simple logger
// ------------------------------------------------------------------
function log(...args) {
  if (LOG_LEVEL !== "info") return;
  console.log("[AVA-PODIO-PUSH]", ...args);
}

// ------------------------------------------------------------------
// Active subscriptions store (in-memory)
//   key: channel string (e.g., "/task/307507945")
//   value: { client, subscription }
// ------------------------------------------------------------------
const active = new Map();

// ------------------------------------------------------------------
// Helpers: forward payloads
// ------------------------------------------------------------------
async function forwardToAVA(payload) {
  if (!AVA_TOPIC_URL) return;
  try {
    await axios.post(AVA_TOPIC_URL, payload, { headers: { "Content-Type": "application/json" } });
    log("→ Forwarded to AVA_TOPIC_URL");
  } catch (err) {
    console.error("Forward AVA error:", err.response?.status, err.response?.data || err.message);
  }
}

async function forwardToDebug(payload) {
  if (!DEBUG_WEBHOOK_URL) return;
  try {
    await axios.post(DEBUG_WEBHOOK_URL, payload, { headers: { "Content-Type": "application/json" } });
    log("→ Mirrored to DEBUG_WEBHOOK_URL");
  } catch (err) {
    console.error("Forward DEBUG error:", err.response?.status, err.response?.data || err.message);
  }
}

// ------------------------------------------------------------------
// Subscribe logic
// ------------------------------------------------------------------
async function subscribeToChannel({ channel, signature, timestamp }) {
  // If already subscribed, return current status
  if (active.has(channel)) {
    return { status: "already_subscribed", channel };
  }

  // Create a dedicated CometD/Faye client for this channel
  const client = new Faye.Client(PODIO_COMETD_URL, {
    timeout: 60,           // seconds
    retry: 5,              // seconds before retry
  });

  // Inject the private_pub auth ONLY on subscribe for this channel
  client.addExtension({
    outgoing: function (message, callback) {
      if (message.channel === "/meta/subscribe" && message.subscription === channel) {
        message.ext = message.ext || {};
        message.ext.private_pub_signature = String(signature);
        message.ext.private_pub_timestamp = String(timestamp);
      }
      callback(message);
    }
  });

  // Subscribe and forward all push messages to AVA + DEBUG
  const subscription = client.subscribe(channel, async (pushPayload) => {
    // pushPayload has the Podio push structure: { ref, event, created_by, ... }
    log(`Received push on ${channel}:`, JSON.stringify(pushPayload));
    const envelope = {
      meta: {
        channel,
        received_at: new Date().toISOString(),
        source: "podio-push"
      },
      push_event: pushPayload
    };
    await forwardToAVA(envelope);
    await forwardToDebug(envelope);
  });

  // Attach basic error logging
  subscription.errback((err) => {
    console.error(`Subscription error on ${channel}:`, err?.message || err);
  });

  // Confirm handshake by waiting for initial subscribe success
  await new Promise((resolve, reject) => {
    let done = false;
    subscription.callback(() => {
      if (done) return;
      done = true;
      resolve();
    });
    setTimeout(() => {
      if (done) return;
      reject(new Error("Subscribe timeout (no confirmation received)"));
    }, 15000);
  });

  active.set(channel, { client, subscription });
  log(`✓ Subscribed to ${channel}`);
  return { status: "subscribed", channel };
}

// ------------------------------------------------------------------
// Unsubscribe logic
// ------------------------------------------------------------------
async function unsubscribeFromChannel(channel) {
  const rec = active.get(channel);
  if (!rec) return { status: "not_found", channel };

  try {
    await rec.subscription.cancel();
  } catch (e) {
    // ignore cancel errors
  }
  try {
    rec.client.disconnect();
  } catch (e) {
    // ignore disconnect errors
  }
  active.delete(channel);
  log(`✗ Unsubscribed from ${channel}`);
  return { status: "unsubscribed", channel };
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------

/**
 * POST /subscribe
 * Body:
 * {
 *   "push": {
 *     "channel": "/task/307507945",
 *     "timestamp": 1763059054,
 *     "signature": "040c1759...",
 *     "expires_in": 21600
 *   }
 * }
 */
app.post("/subscribe", async (req, res) => {
  try {
    const push = req.body?.push || {};
    const { channel, signature, timestamp } = push;

    if (!channel || !signature || !timestamp) {
      return res.status(400).json({
        error: "Missing required fields: push.channel, push.signature, push.timestamp"
      });
    }

    const result = await subscribeToChannel({ channel, signature, timestamp });
    return res.json({
      ok: true,
      result,
      cometd: PODIO_COMETD_URL
    });
  } catch (err) {
    console.error("Subscribe error:", err.message || err);
    return res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
});

/**
 * POST /unsubscribe
 * Body:
 * { "channel": "/task/307507945" }
 */
app.post("/unsubscribe", async (req, res) => {
  try {
    const { channel } = req.body || {};
    if (!channel) return res.status(400).json({ error: "Missing body.channel" });

    const result = await unsubscribeFromChannel(channel);
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("Unsubscribe error:", err.message || err);
    return res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
});

/**
 * GET /health
 */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    cometd: PODIO_COMETD_URL,
    subscriptions: Array.from(active.keys())
  });
});

// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  log(`Server listening on :${PORT} (env: ${NODE_ENV})`);
  log(`CometD endpoint: ${PODIO_COMETD_URL}`);
});
