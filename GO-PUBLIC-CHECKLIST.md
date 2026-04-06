# TradeCommand Pro — Go-Public Checklist

## Already Completed

- [x] **Remove password gate (gate.js)** — Deleted gate.js and removed all `<script src="gate.js">` references from every HTML file (dashboard.html, home.html, dashboard-v2.html, index.html, admin.html, business.html, terms.html, privacy.html, deck/index.html, and all DayTrading-Dashboard copies).
- [x] **Remove API key settings from user UI** — Deleted the entire "API Keys" settings section (Finnhub, Alpha Vantage, NewsAPI inputs + Save Keys button) from dashboard.html, home.html, and dashboard-v2.html.
- [x] **Remove hardcoded API keys from frontend code** — Cleared the `ALL_KEYS` object and the `D` state defaults so no real API key values appear anywhere in client-side source code. All API calls now go through secure Cloud Function proxies.
- [x] **Delete users.json** — Removed the Firebase Auth export file that contained password hashes and user email addresses.
- [x] **Delete .bak files** — Removed dashboard.html.bak, index.html.bak, admin.html.bak, business.html.bak that contained old code with keys/passwords.
- [x] **Audit for remaining secrets** — Verified zero matches for: password hashes, gate tokens, hardcoded Finnhub/AlphaVantage/NewsAPI keys across the entire project.

## Stripe Payments — Status: Ready

The Stripe integration is properly structured:

- [x] `createCheckout` Cloud Function creates Stripe Checkout sessions server-side
- [x] `stripeWebhook` handles checkout.session.completed, invoice.payment_succeeded, customer.subscription.deleted, and invoice.payment_failed
- [x] Stripe secret key, webhook secret, and price IDs are stored in Firebase Functions config (not in code)
- [x] Frontend uses `goToStripe('pro')` / `goToStripe('elite')` — no direct Stripe links exposed
- [x] Firestore user records updated with plan, stripeCustomerId, stripeSubscriptionId on successful checkout

### Stripe Action Items (verify before launch)

- [ ] **Confirm Stripe is in live mode** (not test mode) — check your Stripe Dashboard
- [ ] **Verify Firebase config is set** — run: `firebase functions:config:get` and confirm `stripe.secret_key`, `stripe.webhook_secret`, `stripe.pro_price_id`, and `stripe.elite_price_id` are all set with live values
- [ ] **Verify webhook endpoint is registered** in Stripe Dashboard → Developers → Webhooks → pointing to your Cloud Functions URL for `stripeWebhook`
- [ ] **Test a real checkout** with a real card (or Stripe test card if still in test mode) end-to-end: click Upgrade → complete payment → verify Firestore user doc updates with plan/subscription fields
- [ ] **Test cancellation flow** — cancel a subscription in Stripe and verify the webhook downgrades the user to "free" in Firestore

## Pre-Launch Checklist

### Security

- [ ] **Deploy updated Firestore rules** — run `firebase deploy --only firestore:rules` (rules look solid with default-deny + admin checks)
- [ ] **Verify Cloud Functions are deployed** — run `firebase deploy --only functions` to push latest
- [ ] **Review Firebase Auth settings** — ensure email enumeration protection is ON in Firebase Console → Authentication → Settings
- [ ] **Enable App Check** (recommended) — prevents unauthorized API abuse from outside your app
- [ ] **Check CORS settings** — ensure Cloud Functions only accept requests from tradecommandpro.com
- [ ] **Remove or restrict admin.html** — consider adding server-side protection or removing it from public hosting (it has client-side email check but is still accessible)
- [ ] **Remove or restrict business.html** — same as admin, it has admin-only auth checks but the page itself loads publicly

### API Keys (Server-Side)

- [ ] **Verify Firebase Functions config has all API keys** — run: `firebase functions:config:get` and confirm `apis.finnhub`, `apis.alphavantage`, and `apis.newsapi` are set
- [ ] **Rate limits are appropriate** — currently 30 requests/minute per user per endpoint (adjust in functions/index.js if needed)
- [ ] **Consider upgrading API plan tiers** for Finnhub/Alpha Vantage/NewsAPI to handle production traffic

### Domain & Hosting

- [ ] **Custom domain is configured** — tradecommandpro.com pointing to Firebase Hosting
- [ ] **SSL certificate is active** — HTTPS required (Firebase Hosting provides this automatically)
- [ ] **Deploy to Firebase Hosting** — run `firebase deploy --only hosting`

### Legal & Compliance

- [ ] **Terms of Service is current** — review terms.html
- [ ] **Privacy Policy is current** — review privacy.html (includes your contact email)
- [x] **Add financial disclaimer** — persistent disclaimer footer added to all dashboard pages, plus existing inline disclaimers and Terms of Service section 6
- [x] **Cookie consent banner** — added to index.html, dashboard.html, home.html, and dashboard-v2.html with localStorage dismiss

### Monitoring & Analytics

- [ ] **Firebase Crashlytics or error monitoring** — set up alerting for Cloud Function errors
- [ ] **Stripe webhook monitoring** — enable webhook failure alerts in Stripe Dashboard
- [ ] **Google Analytics or equivalent** on dashboard pages
- [ ] **Uptime monitoring** — set up for tradecommandpro.com

### Content & UX

- [ ] **Test all pages load correctly** without the password gate
- [ ] **Test signup → login → dashboard → upgrade flow** end-to-end
- [ ] **Test on mobile** — all dashboard pages use responsive viewport meta tags
- [ ] **Remove or update any "private beta" copy** that may still appear on pages
- [ ] **Verify og:meta tags** for social sharing previews on index.html, dashboard pages

### Cleanup (Optional)

- [ ] **Remove DayTrading-Dashboard/ directory** — appears to be an old backup; keeping it publicly accessible could cause confusion
- [ ] **Remove SETUP-GUIDE.html from production** — contains internal deployment instructions and Firestore rule examples
- [ ] **Remove files/ and deck/ directories** if they shouldn't be public — they contain marketing materials and pitch deck
