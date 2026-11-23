"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const PORT = parseInt(process.env.PORT || "8080", 10);
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "gen-lang-client-0240859276";
const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID || "ai-studio-android-zenithla-8b5ac961-c3fe-44c1-9a72-2b711929fdf7";

const FAMGATEWAY_CREATE_ORDER_URL = "https://famgateway.in/api/create-order";
const FAMGATEWAY_VERIFY_ORDER_URL = "https://famgateway.in/api/verify-order.php";

let firestoreInstance = null;

function getDb() {
  if (firestoreInstance) return firestoreInstance;
  if (admin.apps.length === 0) {
    admin.initializeApp({
      projectId: FIREBASE_PROJECT_ID,
    });
  }
  firestoreInstance = getFirestore(admin.app(), FIRESTORE_DATABASE_ID);
  return firestoreInstance;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function computeExpiryMillis(startedAtMillis, validityDays) {
  const safeDays = Math.max(1, Math.min(36500, parseInt(String(validityDays || 30), 10) || 30));
  return startedAtMillis + safeDays * 86_400_000;
}

function verifyWebhookSignature(rawBodyBuffer, signatureHeader, secret) {
  if (!secret) return false;
  if (!rawBodyBuffer || typeof signatureHeader !== "string" || !signatureHeader.trim()) {
    return false;
  }
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer)
    .digest("hex");
  const cleanHeader = signatureHeader.trim().replace(/^sha256=/i, "");
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const providedBuf = Buffer.from(cleanHeader, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

async function loadGatewaySecrets(db) {
  let apiKey = (process.env.FAMGATEWAY_API_KEY || "").trim();
  let webhookSecret = (process.env.FAMGATEWAY_WEBHOOK_SECRET || "").trim();

  try {
    const secretSnap = await db.collection("admin_secrets").doc("payment_gateway").get();
    if (secretSnap.exists) {
      const data = secretSnap.data() || {};
      if (typeof data.secretApiKey === "string" && data.secretApiKey.trim()) {
        apiKey = data.secretApiKey.trim();
      }
      if (typeof data.webhookSecret === "string" && data.webhookSecret.trim()) {
        webhookSecret = data.webhookSecret.trim();
      }
    }
  } catch (err) {
    console.warn("Could not read /admin_secrets/payment_gateway:", err.message);
  }

  return { apiKey, webhookSecret };
}

async function resolveAuthoritativePlan(db, rawPlanId) {
  const planId = typeof rawPlanId === "string" ? rawPlanId.trim() : "";
  if (!planId || !/^[a-zA-Z0-9_-]{1,64}$/.test(planId)) {
    throw new Error("Invalid subscription planId.");
  }

  const planDoc = await db.collection("subscription_plans").doc(planId).get();
  if (planDoc.exists) {
    const p = planDoc.data() || {};
    if (p.isActive === false) {
      throw new Error("Selected subscription plan is currently disabled.");
    }
    const priceInr = Number(p.priceInr);
    const validityDays = parseInt(String(p.validityDays || 30), 10);
    if (!Number.isFinite(priceInr) || priceInr < 1) {
      throw new Error("Plan price is not configured.");
    }
    return {
      planId,
      planName: String(p.planName || "Pro Subscription").slice(0, 60),
      priceInr: Number(priceInr.toFixed(2)),
      validityDays: Math.max(1, Math.min(36500, validityDays || 30)),
    };
  }

  // Fallback to global config amounts for built-in SKU identifiers
  const cfgDoc = await db.collection("app_config").doc("global").get();
  const cfg = cfgDoc.exists ? cfgDoc.data() || {} : {};
  if (planId === "android_launcher_pro_monthly") {
    const price = Number(cfg.monthlyAmount || 199);
    return {
      planId,
      planName: "Pro Monthly",
      priceInr: Number.isFinite(price) && price >= 1 ? price : 199,
      validityDays: 30,
    };
  }
  if (planId === "android_launcher_pro_yearly") {
    const price = Number(cfg.yearlyAmount || 1499);
    return {
      planId,
      planName: "Pro Annual",
      priceInr: Number.isFinite(price) && price >= 1 ? price : 1499,
      validityDays: 365,
    };
  }
  if (planId === "android_launcher_pro_lifetime") {
    const price = Number(cfg.lifetimeAmount || 3999);
    return {
      planId,
      planName: "Studio Lifetime",
      priceInr: Number.isFinite(price) && price >= 1 ? price : 3999,
      validityDays: 3650,
    };
  }

  throw new Error("Subscription plan not found.");
}

async function authenticateFirebaseUser(req) {
  const authHeader = req.get("Authorization") || "";
  let token = "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (req.body && typeof req.body.firebaseIdToken === "string") {
    token = req.body.firebaseIdToken.trim();
  }
  if (!token) {
    const err = new Error("Missing Firebase authentication token.");
    err.statusCode = 401;
    throw err;
  }
  getDb();
  return admin.auth().verifyIdToken(token);
}

async function activateUserSubscription(db, orderData, transactionId) {
  const orderId = String(orderData.orderId);
  const userId = String(orderData.userId);
  const cleanTx = String(transactionId || orderId).trim().slice(0, 128);
  const orderRef = db.collection("payment_orders").doc(orderId);
  const userRef = db.collection("users").doc(userId);
  const receiptRef = userRef.collection("purchases").doc(orderId);

  return db.runTransaction(async (tx) => {
    const freshOrderSnap = await tx.get(orderRef);
    const currentOrder = freshOrderSnap.exists ? freshOrderSnap.data() || {} : orderData;

    const now = Date.now();
    const startedAtMillis =
      typeof currentOrder.planStartedAtMillis === "number" && currentOrder.planStartedAtMillis > 0
        ? currentOrder.planStartedAtMillis
        : now;
    const expiresAtMillis =
      typeof currentOrder.planExpiresAtMillis === "number" && currentOrder.planExpiresAtMillis > 0
        ? currentOrder.planExpiresAtMillis
        : computeExpiryMillis(startedAtMillis, currentOrder.validityDays);

    tx.set(
      orderRef,
      {
        status: "PAID",
        gatewayTransactionId: cleanTx,
        planStartedAtMillis: startedAtMillis,
        planExpiresAtMillis: expiresAtMillis,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      userRef,
      {
        userId,
        premiumActive: true,
        subscriptionActive: true,
        planId: String(currentOrder.planId),
        planName: String(currentOrder.planName),
        planStartedAtMillis: startedAtMillis,
        planExpiresAtMillis: expiresAtMillis,
        activeProductId: String(currentOrder.planId),
        purchaseSource: "PAYMENT_GATEWAY",
        purchaseTokenHash: sha256Hex(cleanTx).slice(0, 64),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      receiptRef,
      {
        userId,
        productId: String(currentOrder.planId),
        purchaseSource: "PAYMENT_GATEWAY",
        purchaseTokenHash: sha256Hex(cleanTx).slice(0, 64),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      orderId,
      userId,
      planId: String(currentOrder.planId),
      planName: String(currentOrder.planName),
      planStartedAtMillis: startedAtMillis,
      planExpiresAtMillis: expiresAtMillis,
      transactionId: cleanTx,
    };
  });
}

function isGatewayPaidPayload(json, expectedAmountInr) {
  if (!json || typeof json !== "object") return false;
  const statusStr = String(json.status || json.payment_status || "").trim().toLowerCase();
  const isStatusPaid = ["success", "paid", "completed", "captured", "active"].includes(statusStr);
  if (!isStatusPaid) return false;
  if (json.amount !== undefined && json.amount !== null && json.amount !== "") {
    const paidAmount = Number(json.amount);
    if (!Number.isFinite(paidAmount) || paidAmount + 0.01 < Number(expectedAmountInr || 0)) {
      return false;
    }
  }
  return true;
}

async function queryFamGatewayStatus(orderId, apiKey) {
  const url = `${FAMGATEWAY_VERIFY_ORDER_URL}?order_id=${encodeURIComponent(orderId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Api-Key": apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, json: JSON.parse(text) };
  } catch {
    return { ok: response.ok, status: response.status, json: null, raw: text };
  }
}

function resolvePublicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BACKEND_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured.startsWith("https://") || configured.startsWith("http://")) {
    return configured;
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host") || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createApp(options = {}) {
  const app = express();
  app.set("trust proxy", 1);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    return next();
  });

  app.use(
    express.json({
      limit: "256kb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const dbProvider = options.dbProvider || getDb;
  const authFn = options.authenticateFn || authenticateFirebaseUser;
  const famStatusFn = options.queryFamGatewayStatusFn || queryFamGatewayStatus;

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "famgateway-v2-subscription-backend" });
  });

  async function handleCreateOrder(req, res) {
    try {
      const decoded = await authFn(req);
      const db = dbProvider();
      const rawPlanId = req.body?.planId || req.body?.productId;
      const plan = await resolveAuthoritativePlan(db, rawPlanId);
      const { apiKey } = await loadGatewaySecrets(db);
      if (!apiKey) {
        return res.status(503).json({
          status: "error",
          message: "FamGateway Secret API Key is not configured yet in Admin Vault.",
        });
      }

      const orderId = `fg_${decoded.uid.slice(0, 8)}_${Date.now()}_${crypto
        .randomBytes(3)
        .toString("hex")}`;
      const baseUrl = resolvePublicBaseUrl(req);
      const customerName = String(
        decoded.name || req.body?.displayName || decoded.email || "Launcher Member"
      )
        .trim()
        .slice(0, 60);

      const gatewayPayload = {
        order_id: orderId,
        amount: plan.priceInr,
        customer_name: customerName,
        customer_email: String(decoded.email || "").slice(0, 120),
        redirect_url: `${baseUrl}/payment-return?order_id=${encodeURIComponent(orderId)}`,
        webhook_url: `${baseUrl}/famgateway-webhook`,
        remark1: decoded.uid,
        remark2: plan.planId,
      };

      const gwRes = await fetch(FAMGATEWAY_CREATE_ORDER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Api-Key": apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(gatewayPayload),
      });

      const gwText = await gwRes.text();
      let gwJson = {};
      try {
        gwJson = JSON.parse(gwText);
      } catch {
        gwJson = {};
      }

      const checkoutUrl = String(
        gwJson.checkout_url || gwJson.checkoutUrl || gwJson.payment_url || gwJson.url || ""
      ).trim();
      const gatewayOrderId = String(gwJson.order_id || gwJson.orderId || orderId).trim();

      if (!gwRes.ok || !checkoutUrl) {
        return res.status(502).json({
          status: "error",
          message: gwJson.message || "FamGateway did not return a valid checkout_url.",
        });
      }

      await db.collection("payment_orders").doc(orderId).set({
        orderId,
        gatewayOrderId,
        userId: decoded.uid,
        planId: plan.planId,
        planName: plan.planName,
        priceInr: plan.priceInr,
        validityDays: plan.validityDays,
        status: "PENDING",
        checkoutUrl,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return res.json({
        status: "success",
        orderId,
        order_id: orderId,
        gatewayOrderId,
        checkoutUrl,
        checkout_url: checkoutUrl,
        planId: plan.planId,
        planName: plan.planName,
        priceInr: plan.priceInr,
        validityDays: plan.validityDays,
      });
    } catch (err) {
      const code = err.statusCode || 400;
      return res.status(code).json({
        status: "error",
        message: err.message || "Failed to create FamGateway order.",
      });
    }
  }

  app.post("/api/create-order", handleCreateOrder);
  app.post("/api/payments/create-checkout", handleCreateOrder);

  async function handleVerifyOrder(req, res) {
    try {
      const decoded = await authFn(req);
      const db = dbProvider();
      const rawOrderId =
        req.query?.order_id ||
        req.query?.orderId ||
        req.body?.order_id ||
        req.body?.orderId ||
        "";
      const orderId = String(rawOrderId).trim();
      if (!orderId || !/^[a-zA-Z0-9_-]{3,128}$/.test(orderId)) {
        return res.status(400).json({ status: "error", verified: false, paid: false, message: "Invalid orderId." });
      }

      const orderSnap = await db.collection("payment_orders").doc(orderId).get();
      if (!orderSnap.exists) {
        return res.status(404).json({ status: "error", verified: false, paid: false, message: "Order not found." });
      }
      const order = orderSnap.data() || {};
      if (order.userId !== decoded.uid) {
        return res.status(403).json({ status: "error", verified: false, paid: false, message: "Order ownership mismatch." });
      }

      if (order.status === "PAID") {
        const activation = await activateUserSubscription(
          db,
          order,
          order.gatewayTransactionId || orderId
        );
        return res.json({
          status: "paid",
          verified: true,
          paid: true,
          subscriptionActive: true,
          orderId,
          transactionId: activation.transactionId,
          planId: activation.planId,
          planName: activation.planName,
          planStartedAtMillis: activation.planStartedAtMillis,
          planExpiresAtMillis: activation.planExpiresAtMillis,
          message: `${activation.planName} unlocked!`,
        });
      }

      const { apiKey } = await loadGatewaySecrets(db);
      if (!apiKey) {
        return res.json({
          status: "pending",
          verified: false,
          paid: false,
          subscriptionActive: false,
          orderId,
          message: "Waiting for webhook confirmation...",
        });
      }

      const lookupId = String(order.gatewayOrderId || orderId);
      const gwCheck = await famStatusFn(lookupId, apiKey);
      const gwJson = gwCheck.json || {};
      if (isGatewayPaidPayload(gwJson, order.priceInr)) {
        const txId = String(
          gwJson.utr || gwJson.transaction_id || gwJson.transactionId || gwJson.payment_id || lookupId
        ).trim();
        const activation = await activateUserSubscription(db, order, txId);
        return res.json({
          status: "paid",
          verified: true,
          paid: true,
          subscriptionActive: true,
          orderId,
          transactionId: activation.transactionId,
          planId: activation.planId,
          planName: activation.planName,
          planStartedAtMillis: activation.planStartedAtMillis,
          planExpiresAtMillis: activation.planExpiresAtMillis,
          message: `${activation.planName} activated automatically!`,
        });
      }

      return res.json({
        status: "pending",
        verified: false,
        paid: false,
        subscriptionActive: false,
        orderId,
        message: String(gwJson.message || "Waiting for UPI payment confirmation..."),
      });
    } catch (err) {
      const code = err.statusCode || 500;
      return res.status(code).json({
        status: "error",
        verified: false,
        paid: false,
        message: err.message || "Verification failed.",
      });
    }
  }

  app.get("/api/verify-order.php", handleVerifyOrder);
  app.post("/api/verify-order.php", handleVerifyOrder);
  app.post("/api/payments/verify", handleVerifyOrder);

  async function handleWebhook(req, res) {
    try {
      const db = dbProvider();
      const { apiKey, webhookSecret } = await loadGatewaySecrets(db);
      const sigHeader = req.get("X-FamGateway-Signature") || req.get("x-famgateway-signature") || "";

      if (webhookSecret) {
        const validSig = verifyWebhookSignature(req.rawBody, sigHeader, webhookSecret);
        if (!validSig) {
          return res.status(401).json({ status: "error", message: "Invalid webhook signature." });
        }
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const orderId = String(body.order_id || body.orderId || "").trim();
      if (!orderId || !/^[a-zA-Z0-9_-]{3,128}$/.test(orderId)) {
        return res.status(400).json({ status: "error", message: "Invalid order_id in webhook." });
      }

      let orderSnap = await db.collection("payment_orders").doc(orderId).get();
      if (!orderSnap.exists) {
        const altQuery = await db
          .collection("payment_orders")
          .where("gatewayOrderId", "==", orderId)
          .limit(1)
          .get();
        if (!altQuery.empty) {
          orderSnap = altQuery.docs[0];
        }
      }

      if (!orderSnap.exists) {
        return res.status(404).json({ status: "error", message: "Unknown order." });
      }

      const order = orderSnap.data() || {};

      // Re-verify directly with FamGateway v2 API whenever API key is configured
      let verifiedPaid = isGatewayPaidPayload(body, order.priceInr);
      let txId = String(body.utr || body.transaction_id || body.transactionId || orderId).trim();

      if (apiKey) {
        const gwCheck = await famStatusFn(String(order.gatewayOrderId || order.orderId), apiKey);
        if (gwCheck.json && isGatewayPaidPayload(gwCheck.json, order.priceInr)) {
          verifiedPaid = true;
          txId = String(
            gwCheck.json.utr || gwCheck.json.transaction_id || gwCheck.json.transactionId || txId
          ).trim();
        } else if (!webhookSecret) {
          // Without HMAC secret, insist on positive server-to-server verification
          verifiedPaid = false;
        }
      } else if (!webhookSecret) {
        return res.status(503).json({ status: "error", message: "Gateway secrets not configured." });
      }

      if (!verifiedPaid) {
        return res.status(200).json({ status: "ignored", message: "Payment not yet settled." });
      }

      const activation = await activateUserSubscription(db, order, txId);
      return res.status(200).json({
        status: "received",
        subscriptionActive: true,
        orderId: activation.orderId,
        planId: activation.planId,
        planExpiresAtMillis: activation.planExpiresAtMillis,
      });
    } catch (err) {
      return res.status(500).json({ status: "error", message: err.message || "Webhook failed." });
    }
  }

  app.post("/famgateway-webhook", handleWebhook);
  app.post("/api/famgateway-webhook", handleWebhook);

  app.get("/payment-return", (req, res) => {
    const orderId = escapeHtml(String(req.query?.order_id || req.query?.orderId || ""));
    const safeJsOrderId = JSON.stringify(String(req.query?.order_id || req.query?.orderId || ""));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Payment Status</title>
  <style>
    body{margin:0;background:#080B18;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
    .card{background:rgba(255,255,255,.06);border:1px solid rgba(0,229,255,.35);border-radius:20px;padding:28px;max-width:380px;width:100%}
    h2{margin:0 0 8px;color:#00E5FF}
    p{margin:0;color:#CBD5E1;font-size:14px;line-height:1.5}
  </style>
</head>
<body>
  <div class="card">
    <h2>Verifying Auto-UPI Payment…</h2>
    <p>Order <strong>${orderId}</strong> is syncing with your subscription. You can stay on this screen — Pro unlocks automatically.</p>
  </div>
  <script>
    try {
      if (window.AndroidGatewayBridge && typeof window.AndroidGatewayBridge.onPaymentCompleted === "function") {
        window.AndroidGatewayBridge.onPaymentCompleted(${safeJsOrderId});
      }
    } catch (_) {}
  </script>
</body>
</html>`);
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`FamGateway v2.0 backend listening on port ${PORT}`);
  });
}

module.exports = {
  createApp,
  computeExpiryMillis,
  verifyWebhookSignature,
  isGatewayPaidPayload,
  activateUserSubscription,
};
