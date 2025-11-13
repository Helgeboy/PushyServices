// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

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

// Required for DO:
const PORT = process.env.PORT || 8080;

// --------------------------------------------------
// Logging Utility
// --------------------------------------------------
function log(...args) {
  if (LOG_LEVEL !== "info") return;
  console.log("[AVA-PODIO]", ...args);
}

// --------------------------------------------------
// STEP 1: Helper – Validate Podio Push Signatures
// --------------------------------------------------
function validatePodioSignature(body, signature) {
  const computed = crypto
    .createHmac("sha1", PODIO_PUSH_SECRET)
    .update(JSON.stringify(body))
    .digest("hex");

  return computed === signature;
}

// --------------------------------------------------
// STEP 2: Forward Payload to AVA Topic
// --------------------------------------------------
async function forwardToAVA(payload) {
  try {
    await axios.post(AVA_TOPIC_URL, payload, {
      headers: { "Content-Type": "application/json" }
    });
    log("✓ Forwarded to AVA");
  } catch (err) {
    console.error("❌ Error forwarding to AVA:", err.response?.data || err.message);
  }
}

// Optional debug webhook mirroring
async function forwardToDebug(payload) {
  if (!DEBUG_WEBHOOK_URL) return;
  try {
    await axios.post(DEBUG_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" }
    });
    log("✓ Mirrored to debug webhook");
  } catch (err) {
    console.error("❌ Debug webhook error:", err.response?.data || err.message);
  }
}

// --------------------------------------------------
// STEP 3: Podio Push Webhook Endpoint
// --------------------------------------------------
// Podio will POST handshake + verification + actual push events here.
app.post("/podio/push", async (req, res) => {
  const body = req.body;

  // Podio Handshake challenge
  if (body.type === "subscription_verification") {
    log("Handshake challenge received.");

    // Return the challenge to confirm subscription
    return res.json({
      status: "ok",
      "subscribe_url": `${APP_BASE_URL}/podio/push`,
      "challenge": body["challenge"]
    });
  }

  // Validate signature header
  const signature = req.headers["x-podio-signature"];

  if (!signature || !validatePodioSignature(body, signature)) {
    console.error("❌ Invalid Podio signature");
    return res.status(401).send("Invalid signature");
  }

  log("✓ Valid Podio push event received.");
  log(JSON.stringify(body, null, 2));

  // Forward event to AVA
  forwardToAVA(body);

  // Optional debug mirroring
  forwardToDebug(body);

  return res.status(200).send("OK");
});

// --------------------------------------------------
// STEP 4: Server Listening
// --------------------------------------------------
app.listen(PORT, () =>
  log(`Server running on port ${PORT} (ENV: ${NODE_ENV})`)
);
