const functions = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// ── CONFIG ──────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY     = functions.config().stripe?.secret_key     || process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = functions.config().stripe?.webhook_secret || process.env.STRIPE_WEBHOOK_SECRET;
const PRO_PRICE_ID          = functions.config().stripe?.pro_price_id;
const ELITE_PRICE_ID        = functions.config().stripe?.elite_price_id;

// API keys — set via: firebase functions:config:set apis.finnhub="YOUR_KEY" apis.alphavantage="YOUR_KEY" apis.newsapi="YOUR_KEY"
const FINNHUB_KEY      = functions.config().apis?.finnhub      || process.env.FINNHUB_KEY;
const ALPHAVANTAGE_KEY = functions.config().apis?.alphavantage || process.env.ALPHAVANTAGE_KEY;
const NEWSAPI_KEY      = functions.config().apis?.newsapi      || process.env.NEWSAPI_KEY;

const ADMIN_EMAIL = "max.mcdonough123@gmail.com";

// ── RATE LIMITING ───────────────────────────────────────────────────────────
// In-memory rate limiter (resets on cold start, good enough for Cloud Functions)
const rateLimits = {};
function checkRateLimit(uid, endpoint, maxPerMinute = 30) {
  const key = `${uid}:${endpoint}`;
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  // Remove entries older than 1 minute
  rateLimits[key] = rateLimits[key].filter(ts => now - ts < 60000);
  if (rateLimits[key].length >= maxPerMinute) return false;
  rateLimits[key].push(now);
  return true;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
async function getUserByEmail(email) {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return userRecord.uid;
  } catch (e) {
    const snap = await db.collection("users").where("email", "==", email).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
    return null;
  }
}

function planFromPriceId(priceId) {
  if (priceId === PRO_PRICE_ID)   return "pro";
  if (priceId === ELITE_PRICE_ID) return "elite";
  return null;
}

function requireAuth(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  }
  return context.auth;
}

function requireAdmin(context) {
  const auth = requireAuth(context);
  if (auth.token.email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required");
  }
  return auth;
}

// Input sanitization
function sanitizeSymbol(sym) {
  if (!sym || typeof sym !== "string") return null;
  // Stock symbols: 1-10 uppercase alphanumeric chars, dots, dashes
  const clean = sym.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  return clean.length > 0 && clean.length <= 10 ? clean : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── API PROXY FUNCTIONS (keys stay server-side) ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ── Finnhub Quote Proxy ──────────────────────────────────────────────────
exports.finnhubQuote = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  if (!checkRateLimit(context.auth.uid, "finnhubQuote", 60)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded. Try again in a minute.");
  }
  const sym = sanitizeSymbol(data.symbol);
  if (!sym) throw new functions.https.HttpsError("invalid-argument", "Invalid symbol");
  if (!FINNHUB_KEY) throw new functions.https.HttpsError("unavailable", "Finnhub not configured");

  const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
  if (!resp.ok) throw new functions.https.HttpsError("unavailable", "Finnhub API error");
  return await resp.json();
});

// ── Finnhub Candles Proxy ────────────────────────────────────────────────
exports.finnhubCandles = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  if (!checkRateLimit(context.auth.uid, "finnhubCandles", 30)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded");
  }
  const sym = sanitizeSymbol(data.symbol);
  if (!sym) throw new functions.https.HttpsError("invalid-argument", "Invalid symbol");
  if (!FINNHUB_KEY) throw new functions.https.HttpsError("unavailable", "Finnhub not configured");

  const res = data.resolution || "D";
  const from = parseInt(data.from) || Math.floor(Date.now() / 1000) - 86400 * 30;
  const to = parseInt(data.to) || Math.floor(Date.now() / 1000);
  const validRes = ["1", "5", "15", "30", "60", "D", "W", "M"];
  if (!validRes.includes(res)) throw new functions.https.HttpsError("invalid-argument", "Invalid resolution");

  const resp = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${sym}&resolution=${res}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
  if (!resp.ok) throw new functions.https.HttpsError("unavailable", "Finnhub API error");
  return await resp.json();
});

// ── Finnhub General Proxy (company profile, peers, etc.) ─────────────────
exports.finnhubProxy = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  if (!checkRateLimit(context.auth.uid, "finnhubProxy", 30)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded");
  }
  if (!FINNHUB_KEY) throw new functions.https.HttpsError("unavailable", "Finnhub not configured");

  // Whitelist of allowed endpoints
  const allowed = ["/stock/profile2", "/stock/peers", "/stock/recommendation", "/stock/metric",
    "/company-news", "/stock/insider-transactions", "/stock/financials-reported",
    "/crypto/candle", "/forex/candle", "/news"];
  const ep = data.endpoint;
  if (!ep || !allowed.some(a => ep.startsWith(a))) {
    throw new functions.https.HttpsError("invalid-argument", "Endpoint not allowed");
  }

  // Build query params, replacing any token param
  const params = { ...data.params };
  delete params.token;
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const url = `https://finnhub.io/api/v1${ep}?${qs}&token=${FINNHUB_KEY}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new functions.https.HttpsError("unavailable", "Finnhub API error");
  return await resp.json();
});

// ── Alpha Vantage Proxy ──────────────────────────────────────────────────
exports.alphaVantage = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  if (!checkRateLimit(context.auth.uid, "alphaVantage", 10)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded (AV allows ~5/min on free tier)");
  }
  if (!ALPHAVANTAGE_KEY) throw new functions.https.HttpsError("unavailable", "Alpha Vantage not configured");

  // Whitelist allowed functions
  const allowedFns = ["OVERVIEW", "INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW",
    "EARNINGS", "TIME_SERIES_DAILY", "TIME_SERIES_INTRADAY", "GLOBAL_QUOTE",
    "SECTOR", "RSI", "MACD", "SMA", "EMA"];
  const fn = data.function;
  if (!fn || !allowedFns.includes(fn.toUpperCase())) {
    throw new functions.https.HttpsError("invalid-argument", "Function not allowed");
  }

  const params = { ...data.params, function: fn, apikey: ALPHAVANTAGE_KEY };
  delete params.apikey_user; // strip any user-supplied key
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const resp = await fetch(`https://www.alphavantage.co/query?${qs}`);
  if (!resp.ok) throw new functions.https.HttpsError("unavailable", "Alpha Vantage API error");
  return await resp.json();
});

// ── NewsAPI Proxy ────────────────────────────────────────────────────────
exports.newsHeadlines = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  if (!checkRateLimit(context.auth.uid, "newsHeadlines", 10)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded");
  }
  if (!NEWSAPI_KEY) throw new functions.https.HttpsError("unavailable", "NewsAPI not configured");

  const category = (data.category || "business").replace(/[^a-z]/g, "");
  const pageSize = Math.min(parseInt(data.pageSize) || 20, 50);
  const resp = await fetch(`https://newsapi.org/v2/top-headlines?category=${category}&language=en&pageSize=${pageSize}&apiKey=${NEWSAPI_KEY}`);
  if (!resp.ok) throw new functions.https.HttpsError("unavailable", "NewsAPI error");
  return await resp.json();
});

exports.newsSearch = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  if (!checkRateLimit(context.auth.uid, "newsSearch", 10)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded");
  }
  if (!NEWSAPI_KEY) throw new functions.https.HttpsError("unavailable", "NewsAPI not configured");

  const q = sanitizeSymbol(data.query);
  if (!q) throw new functions.https.HttpsError("invalid-argument", "Invalid query");
  const pageSize = Math.min(parseInt(data.pageSize) || 5, 20);
  const resp = await fetch(`https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=${pageSize}&apiKey=${NEWSAPI_KEY}`);
  if (!resp.ok) throw new functions.https.HttpsError("unavailable", "NewsAPI error");
  return await resp.json();
});

// ═══════════════════════════════════════════════════════════════════════════
// ── STRIPE FUNCTIONS ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ── Create Checkout Session (replaces exposed buy.stripe.com links) ──────
exports.createCheckout = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  if (!STRIPE_SECRET_KEY) throw new functions.https.HttpsError("unavailable", "Stripe not configured");

  const plan = data.plan; // "pro" or "elite"
  const priceId = plan === "elite" ? ELITE_PRICE_ID : PRO_PRICE_ID;
  if (!priceId) throw new functions.https.HttpsError("unavailable", "Price not configured for plan: " + plan);

  const stripeClient = stripe(STRIPE_SECRET_KEY);
  const session = await stripeClient.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    customer_email: context.auth.token.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "https://tradecommandpro.com/dashboard.html?upgrade=success",
    cancel_url: "https://tradecommandpro.com/dashboard.html?upgrade=cancel",
    metadata: { firebaseUid: context.auth.uid }
  });

  return { url: session.url, sessionId: session.id };
});

// ── Stripe Webhook (unchanged from original) ─────────────────────────────
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const stripeClient = stripe(STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Stripe event received:", event.type);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const priceId = session.line_items?.data?.[0]?.price?.id;
        let plan = planFromPriceId(priceId);

        if (!plan && session.subscription) {
          const sub = await stripeClient.subscriptions.retrieve(session.subscription, {
            expand: ["items.data.price"]
          });
          plan = planFromPriceId(sub.items?.data?.[0]?.price?.id);
        }

        if (!email) { console.warn("No email in session"); break; }
        const uid = session.metadata?.firebaseUid || await getUserByEmail(email);
        if (!uid) { console.warn("No Firebase user for:", email); break; }

        await db.collection("users").doc(uid).set({
          plan: plan || "pro",
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          subscriptionStart: admin.firestore.FieldValue.serverTimestamp(),
          subscriptionEnd: null,
          lastActive: Date.now()
        }, { merge: true });
        console.log(`✅ Upgraded ${email} → ${plan || "pro"}`);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        if (invoice.billing_reason === "subscription_create") break;
        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", invoice.customer).limit(1).get();
        if (snap.empty) break;
        await snap.docs[0].ref.set({ subscriptionEnd: null, lastActive: Date.now() }, { merge: true });
        console.log("✅ Renewal confirmed for:", invoice.customer);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", sub.customer).limit(1).get();
        if (snap.empty) break;
        await snap.docs[0].ref.set({
          plan: "free",
          subscriptionEnd: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log("✅ Subscription cancelled for:", sub.customer);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", invoice.customer).limit(1).get();
        if (!snap.empty) {
          await snap.docs[0].ref.set({
            paymentFailed: true,
            paymentFailedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        console.log("⚠️ Payment failed for:", invoice.customer);
        break;
      }

      default:
        console.log("Unhandled event:", event.type);
    }
  } catch (err) {
    console.error("Error processing webhook:", err);
    return res.status(500).send("Internal error");
  }

  res.status(200).json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── USER & ADMIN FUNCTIONS ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ── Get User Plan ────────────────────────────────────────────────────────
exports.getUserPlan = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  const doc = await db.collection("users").doc(context.auth.uid).get();
  if (!doc.exists) return { plan: "free" };
  const { plan, subscriptionEnd } = doc.data();
  return { plan: plan || "free", subscriptionEnd: subscriptionEnd?.toMillis?.() || null };
});

// ── Set Admin Custom Claim ───────────────────────────────────────────────
// Run once to mark your account as admin:
//   firebase functions:shell → setAdminRole({ email: "max.mcdonough123@gmail.com" })
exports.setAdminRole = functions.https.onCall(async (data, context) => {
  requireAdmin(context);
  const email = data.email;
  if (!email) throw new functions.https.HttpsError("invalid-argument", "Email required");

  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { admin: true });
  return { message: `Admin role set for ${email}` };
});

// ── Verify Admin Status ──────────────────────────────────────────────────
exports.verifyAdmin = functions.https.onCall(async (data, context) => {
  requireAuth(context);
  return {
    isAdmin: context.auth.token.email === ADMIN_EMAIL,
    email: context.auth.token.email
  };
});

// ── Admin: List Users ────────────────────────────────────────────────────
exports.adminListUsers = functions.https.onCall(async (data, context) => {
  requireAdmin(context);
  if (!checkRateLimit(context.auth.uid, "adminListUsers", 10)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded");
  }

  const usersSnap = await db.collection("users").orderBy("lastActive", "desc").limit(100).get();
  const users = [];
  usersSnap.forEach(doc => {
    users.push({ uid: doc.id, ...doc.data() });
  });
  return { users };
});
