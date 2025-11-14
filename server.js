// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const Faye = require("faye");

const app = express();
app.use(express.json({ limit: "2mb" }));

// --------------------------------------------------
// Environment Variables
// --------------------------------------------------
const {
  PODIO_CLIENT_ID,
  PODIO_CLIENT_SECRET,
  PODIO_PUSH_SECRET,
  APP_BASE_URL,
  AVA_TOPIC_URL,
  DEBUG_WEBHOOK_URL,
  NODE_ENV,
  LOG_LEVEL
} = process.env;

const PORT = process.env.PORT || 8080;

// --------------------------------------------------
// Logging
// --------------------------------------------------
function log(...args) {
  if (LOG_LEVEL && LOG_LEVEL !== "info") return;
  console.log("[AVA-PODIO]", ...args);
}

// --------------------------------------------------
// Forwarders
// --------------------------------------------------
async function forwardToAVA(payload) {
  if (!AVA_TOPIC_URL) return;
  try {
    await axios.post(AVA_TOPIC_URL, payload, {
      headers: { "Content-Type": "application/json" }
    });
    log("✓ Forwarded to AVA");
  } catch (err) {
    console.error("❌ AVA forward error:", err.response?.data || err.message);
  }
}

async function forwardToDebug(payload) {
  if (!DEBUG_WEBHOOK_URL) return;
  try {
    await axios.post(DEBUG_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" }
    });
    log("✓ Mirrored to debug webhook");
  } catch (err) {
    console.error("❌ Debug mirror error:", err.response?.data || err.message);
  }
}

// --------------------------------------------------
// Signature validation for /podio/push
// --------------------------------------------------
function validatePodioSignature(body, signature) {
  const computed = crypto
    .createHmac("sha1", PODIO_PUSH_SECRET || "")
    .update(JSON.stringify(body))
    .digest("hex");
  return computed === signature;
}

// --------------------------------------------------
// In-memory subscription registry
// Map<channel, { client, subscription, createdAt }>
// --------------------------------------------------
const subs = new Map();

// Helper to build the Faye client with Podio’s ext values
function createFayeClient({ channel, signature, timestamp }) {
  // Podio’s Bayeux endpoint
  // (Historically https://podio.com/faye or https://push.podio.com/faye; both proxy to CometD)
  const endpoint = "https://push.podio.com/faye";

  const client = new Faye.Client(endpoint, {
    timeout: 45, // seconds
    retry: 5
  });

  // Attach the required ext fields for this subscription
  client.addExtension({
    outgoing: function(message, callback) {
      if (message.channel === "/meta/subscribe") {
        message.ext = message.ext || {};
        message.ext.private_pub_signature = signature;
        message.ext.private_pub_timestamp = String(timestamp);
      }
      callback(message);
    }
  });

  return client;
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

// Health
app.get("/health", (req, res) => res.status(200).send("OK"));

// 1) Podio -> our webhook: validated + forwarded
app.post("/podio/push", async (req, res) => {
  const body = req.body || {};

  // Handshake for some push providers (not typical for Podio -> keep for safety)
  if (body.type === "subscription_verification" && body.challenge) {
    log("Handshake challenge received.");
    return res.json({
      status: "ok",
      subscribe_url: `${APP_BASE_URL || ""}/podio/push`,
      challenge: body.challenge
    });
  }

  // Validate if header present
  const signature = req.headers["x-podio-signature"];
  if (!signature || !validatePodioSignature(body, signature)) {
    console.error("❌ Invalid Podio signature");
    return res.status(401).send("Invalid signature");
  }

  log("✓ Valid push event received.");
  // Fan-out
  forwardToAVA(body);
  forwardToDebug(body);

  return res.status(200).send("OK");
});

// 2) Subscribe: establish a Faye/CometD subscription for a channel
// Body example:
// { "push": { "channel": "/task/307507945", "timestamp": 1763059054, "signature": "abc", "expires_in": 21600 } }
app.post("/subscribe", async (req, res) => {
  try {
    const push = req.body?.push;
    if (!push || !push.channel || !push.signature || !push.timestamp) {
      return res.status(400).json({ error: "Missing push.channel, push.signature, or push.timestamp" });
    }

    const { channel, signature, timestamp, expires_in } = push;

    // If we already have a sub for this channel, return existing
    if (subs.has(channel)) {
      log(`Subscription already exists for ${channel}`);
      return res.json({
        status: "exists",
        channel,
        expires_in,
        createdAt: subs.get(channel).createdAt
      });
    }

    const client = createFayeClient({ channel, signature, timestamp });

    // Subscribe and forward any events to AVA + debug
    const subscription = client.subscribe(channel, async (message) => {
      // message is the push event payload
      log(`Event on ${channel}:`, JSON.stringify(message));
      await forwardToAVA({ channel, message, received_at: new Date().toISOString() });
      await forwardToDebug({ channel, message, received_at: new Date().toISOString() });
    });

    subscription.then(
      () => log(`✓ Subscribed to ${channel}`),
      (err) => console.error(`❌ Failed to subscribe ${channel}:`, err)
    );

    subs.set(channel, { client, subscription, createdAt: new Date().toISOString() });

    return res.json({
      status: "subscribed",
      channel,
      expires_in: expires_in ?? null
    });
  } catch (e) {
    console.error("❌ /subscribe error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// 3) Unsubscribe: remove an existing subscription
// Body: { "channel": "/task/307507945" }
app.post("/unsubscribe", async (req, res) => {
  try {
    const channel = req.body?.channel;
    if (!channel) return res.status(400).json({ error: "Missing channel" });

    const entry = subs.get(channel);
    if (!entry) return res.json({ status: "not_found", channel });

    await entry.subscription.cancel();
    subs.delete(channel);
    log(`✓ Unsubscribed from ${channel}`);

    return res.json({ status: "unsubscribed", channel });
  } catch (e) {
    console.error("❌ /unsubscribe error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------
// Start
// --------------------------------------------------
app.listen(PORT, () => {
  log(`Server running on port ${PORT} (ENV: ${NODE_ENV})`);
  log(`Public base: ${APP_BASE_URL || "unset"}`);
});
