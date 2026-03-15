const functions = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// ── CONFIG ──────────────────────────────────────────────────────────────────
// Fill these in via Firebase environment config (see SETUP-GUIDE)
const STRIPE_SECRET_KEY   = functions.config().stripe?.secret_key   || process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = functions.config().stripe?.webhook_secret || process.env.STRIPE_WEBHOOK_SECRET;

// Map your Stripe Price IDs → plan names
// Set these after creating products in Stripe:  firebase functions:config:set stripe.pro_price_id="price_xxx" stripe.elite_price_id="price_yyy"
const PRO_PRICE_ID   = functions.config().stripe?.pro_price_id;
const ELITE_PRICE_ID = functions.config().stripe?.elite_price_id;

// ── HELPERS ──────────────────────────────────────────────────────────────────
async function getUserByEmail(email) {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return userRecord.uid;
  } catch (e) {
    // fallback: search Firestore by email
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

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
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

      // ── New subscription created / payment succeeded ──────────────────────
      case "checkout.session.completed": {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const priceId = session.line_items?.data?.[0]?.price?.id;
        // Retrieve full session with line items if needed
        let plan = planFromPriceId(priceId);

        // If priceId not available from session summary, retrieve subscription
        if (!plan && session.subscription) {
          const sub = await stripeClient.subscriptions.retrieve(session.subscription, {
            expand: ["items.data.price"]
          });
          const subPriceId = sub.items?.data?.[0]?.price?.id;
          plan = planFromPriceId(subPriceId);
        }

        if (!email) { console.warn("No email in session"); break; }
        const uid = await getUserByEmail(email);
        if (!uid) { console.warn("No Firebase user found for email:", email); break; }

        const subId = session.subscription;
        const customerId = session.customer;
        const planToSet = plan || "pro"; // default to pro if price mapping missing

        await db.collection("users").doc(uid).set({
          plan: planToSet,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStart: admin.firestore.FieldValue.serverTimestamp(),
          subscriptionEnd: null, // active
          lastActive: Date.now()
        }, { merge: true });

        console.log(`✅ Upgraded ${email} → ${planToSet}`);
        break;
      }

      // ── Invoice paid (recurring renewal) ─────────────────────────────────
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        if (invoice.billing_reason === "subscription_create") break; // handled above
        const customerId = invoice.customer;

        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", customerId).limit(1).get();
        if (snap.empty) { console.warn("No user for customer:", customerId); break; }

        const userRef = snap.docs[0].ref;
        await userRef.set({ subscriptionEnd: null, lastActive: Date.now() }, { merge: true });
        console.log("✅ Renewal confirmed for customer:", customerId);
        break;
      }

      // ── Subscription cancelled / expired ─────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customerId = sub.customer;

        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", customerId).limit(1).get();
        if (snap.empty) { console.warn("No user for customer:", customerId); break; }

        const userRef = snap.docs[0].ref;
        await userRef.set({
          plan: "free",
          subscriptionEnd: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log("✅ Subscription cancelled for customer:", customerId);
        break;
      }

      // ── Payment failed ────────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", customerId).limit(1).get();
        if (snap.empty) break;

        // Log payment failure — don't immediately downgrade, Stripe retries
        await snap.docs[0].ref.set({
          paymentFailed: true,
          paymentFailedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log("⚠️ Payment failed for customer:", customerId);
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
    }
  } catch (err) {
    console.error("Error processing webhook:", err);
    return res.status(500).send("Internal error");
  }

  res.status(200).json({ received: true });
});

// ── GET USER PLAN (called from dashboard to verify plan) ─────────────────────
exports.getUserPlan = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  const uid = context.auth.uid;
  const doc = await db.collection("users").doc(uid).get();
  if (!doc.exists) return { plan: "free" };
  const { plan, subscriptionEnd } = doc.data();
  return { plan: plan || "free", subscriptionEnd: subscriptionEnd?.toMillis?.() || null };
});
