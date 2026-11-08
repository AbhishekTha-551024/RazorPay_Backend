# Magic Calculator - Razorpay Serverless Backend (Node.js & Express on Vercel)

A lightweight Node.js Express serverless backend for creating Razorpay orders and confirming captured payments for the Magic Calculator Android app.

---

## 📁 Project Structure

```text
razorpay-backend/
├── api/
│   └── index.js          # Express app serverless function
├── test/
│   └── payment-api.test.js
├── .gitignore
├── .env.example          # Environment variables template
├── package-lock.json     # Locked dependency tree
├── package.json          # Node dependencies
├── vercel.json           # Vercel serverless routing configuration
└── README.md             # Setup & deployment guide
```

---

## 🛠️ Local Setup & Testing

### 1. Install Dependencies
Use Node.js 20 or newer.

```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and insert your Razorpay Test Key ID and Secret:
```bash
cp .env.example .env
```
Fill in `.env`:
```env
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX
RAZORPAY_KEY_SECRET=XXXXXXXXXXXXXXXXXXXXXXXX
```
Never put the secret in the Android app or commit it to source control. For browser-based clients only, set `CORS_ALLOWED_ORIGINS` to a comma-separated list of exact trusted origins. Native Android clients do not need CORS.

### 3. Start Local Server
```bash
npm run dev
```
The server will run on `http://localhost:3000`.

---

## 🚀 Deploying to Vercel

### Option A: Using Vercel CLI (Fastest)

1. **Install Vercel CLI**:
   ```bash
   npm i -g vercel
   ```

2. **Login to Vercel**:
   ```bash
   vercel login
   ```

3. **Deploy from the `razorpay-backend` folder**:
   ```bash
   vercel
   ```

4. **Add Environment Variables to Vercel**:
   - Go to your Vercel Dashboard -> Select Project -> **Settings** -> **Environment Variables**.
   - Add:
     - `RAZORPAY_KEY_ID` = `rzp_test_...`
     - `RAZORPAY_KEY_SECRET` = `...`
     - `FIREBASE_SERVICE_ACCOUNT_JSON` = the service account JSON for the same Firebase project used by the Android app
   - Use separate Razorpay Test and Live credentials in their corresponding Vercel environments. Never use live credentials to test.
   - Redeploy using:
     ```bash
     vercel --prod
     ```

### Option B: Deploying via GitHub

1. Push the `razorpay-backend` directory (or a standalone repository created from it) to GitHub.
2. Import the repository on [Vercel Dashboard](https://vercel.com/new).
3. Under Environment Variables, add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
4. Click **Deploy**.

---

## 🧪 Testing API Endpoints

### 1. Test Health Endpoint (`GET /api/test`)
```bash
curl -X GET https://your-vercel-app.vercel.app/api/test
```
**Expected Response:**
```json
{
  "success": true,
  "message": "Razorpay backend serverless function is live!",
  "timestamp": "2026-07-29T20:44:00.000Z",
  "envConfigured": true
}
```

---

### 2. Test Create Order (`POST /api/create-order`)
```bash
curl -X POST https://your-vercel-app.vercel.app/api/create-order \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN" \
  -d '{
    "amount": 149,
    "currency": "INR",
    "planType": "WEEKLY"
  }'
```
The backend owns the supported plan catalog and rejects client-supplied prices that do not match it: Weekly ₹149, Monthly ₹299, Yearly ₹1,999, and Lifetime ₹1,999. It records the normalized plan in the Razorpay order notes.
**Expected Response:**
```json
{
  "success": true,
  "orderId": "order_P1XyZ9abc123",
  "amount": 14900,
  "currency": "INR",
  "receipt": "mc_1794052000000_a1b2c3d4e5f60708",
  "key": "rzp_test_XXXXXXXXXXXXXX"
}
```

---

### 3. Test Verify Payment Signature (`POST /api/verify-payment`)
```bash
curl -X POST https://your-vercel-app.vercel.app/api/verify-payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer FIREBASE_ID_TOKEN" \
  -d '{
    "razorpay_order_id": "order_P1XyZ9abc123",
    "razorpay_payment_id": "pay_P1XyZ9paymentId",
    "razorpay_signature": "generated_hmac_sha256_signature",
    "planType": "WEEKLY"
  }'
```
**Expected Response (Success):**
```json
{
  "status": "success",
  "success": true,
  "message": "Payment verified successfully",
  "paymentId": "pay_P1XyZ9paymentId",
  "orderId": "order_P1XyZ9abc123"
}
```

Order creation requires a valid Firebase ID token and binds the verified UID to the Razorpay order notes. Verification checks the HMAC signature, authenticates the same Firebase user, fetches the order and payment from Razorpay, and only returns success for a captured payment whose owner, order, amount, currency, and plan match. Before returning success, the endpoint uses Firebase Admin to atomically merge the premium entitlement and append the transaction under that verified user's Firestore document. Repeated verification of the same payment is idempotent and does not extend its expiry.

## Add “Pay by QR on another phone”

This is **not a camera-scanner feature**. The app displays a payment QR on the customer’s current phone; the customer scans it with a UPI app on another phone. Do not generate a QR from a client-supplied UPI ID or unlock Premium from a screenshot or a client-side “paid” button.

### Setup and implementation sequence

1. **Confirm Razorpay account support first.** QR Codes are available in India. Razorpay documents `upi_qr` as an on-demand feature, so contact Razorpay Support to enable it for your account before building the flow. Create separate Test and Live webhook configurations.

2. **Add a separate, authenticated backend endpoint**, for example `POST /api/create-qr`. The Android app sends its selected `planType` and Firebase ID token. On the server, verify the token, derive the Firebase UID from the verified token (never trust a UID supplied in the JSON), and validate the plan and price using the server’s plan catalog.

3. **Create one fixed-price, single-use QR on the backend** using Razorpay’s QR Codes API. The Razorpay secret must stay on the server:

   ```js
   const qr = await razorpay.qrCode.create({
     type: 'upi_qr',
     name: `Premium ${planType}`,
     usage: 'single_use',
     fixed_amount: true,
     payment_amount: PLAN_PRICES_INR[planType] * 100, // paise
     description: `Magic Calculator ${planType}`,
     close_by: Math.floor(Date.now() / 1000) + 20 * 60,
     notes: {
       uid,
       planType,
       purchaseAttemptId,
     },
   });
   ```

   Razorpay requires `fixed_amount: true` for a single-use QR. `close_by` must be at least 15 minutes after creation; single-use QR codes without a close time automatically expire after 45 days. Use a short practical expiry and allow the user to request a fresh QR if it expires.

4. **Persist a pending purchase on the server** and associate it with the verified UID, plan, exact amount, QR ID, and a unique purchase-attempt ID. Make creation idempotent for a retry/double tap so network retries do not create confusing duplicate pending purchases. Return only the QR ID, image URL, expiry, attempt ID, plan, and amount to the app.

5. **Display the QR in Android.** Show the plan and amount beside it, explain “Scan with another phone’s UPI app,” and show a waiting/expiry state. Render the `image_url` returned by Razorpay (or its documented image content if enabled); the app does not need camera permission. Provide Cancel/Refresh actions; cancellation should close the active QR server-side.

6. **Confirm payment server-to-server.** Configure Razorpay’s `qr_code.credited` webhook. Verify `X-Razorpay-Signature` using the webhook secret and the exact raw request body (capture raw bytes before JSON parsing). Handle duplicate webhook deliveries idempotently using the event ID. Confirm the QR/payment IDs, captured status, amount, currency, plan, and pending UID/attempt association before marking the attempt paid and granting Premium in Firestore.

7. **Update the app from trusted status.** After showing the QR, the app can listen to a server-written Firestore purchase-status record (with strict rules) or poll an authenticated backend status endpoint. The app should show “Payment received” only after the trusted server has confirmed the payment. Do not use the existing `/api/verify-payment` signature callback as the QR confirmation mechanism: QR payments use the asynchronous QR webhook flow, and Razorpay notes that an order ID is generated when a customer pays via a QR Code.

8. **Test before going live.** Follow Razorpay’s QR webhook testing instructions and verify pending, successful, expired, cancelled, duplicate-webhook, and delayed-webhook cases. Razorpay’s docs warn that Test Mode QR codes created through the payment-gateway flow may disappear after two seconds and QR codes can only be scanned in Live Mode. Do not make a real payment merely to test; ask Razorpay Support which test flow is enabled for your account. Test Mode and Live Mode keys/webhooks must not be mixed.

### QR backend endpoints now implemented locally

- `POST /api/create-qr` requires a Firebase ID token in `Authorization: Bearer ...`, a UUID v4 `Idempotency-Key`, and a supported `planType`. Price is selected on the server. It creates a 20-minute single-use fixed-amount UPI QR and stores a pending attempt in Firestore.
- `GET /api/qr-status/:attemptId` requires the same Firebase authentication and only returns the signed-in user's attempt.
- `POST /api/razorpay/webhook` validates `X-Razorpay-Signature` against the exact raw body and requires `X-Razorpay-Event-Id`. On `qr_code.credited`, it fetches the QR/payment from Razorpay, checks captured status, amount, plan and UID association, then atomically writes the attempt status, user entitlement and transaction record in Firestore. Duplicate webhook events are handled idempotently.

These endpoints require `FIREBASE_SERVICE_ACCOUNT_JSON`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` in the deployment environment. Generate a Firebase service account from Firebase Console → Project settings → Service accounts. Store the complete JSON only in Vercel Environment Variables; never commit or share it. Give the service account only the project-level access needed to verify Firebase ID tokens and write Firestore (Firebase Admin SDK uses the service account's project IAM permissions).

**Still required before QR payments work end to end:** deploy this backend, configure the Razorpay webhook in the correct Test Mode with the deployed `/api/razorpay/webhook` URL and the same webhook secret, and implement the Android QR UI/client calls for create/status. Restrict Firestore client writes to subscription entitlement fields so the app cannot grant Premium directly. The QR webhook grants Premium server-side only after validation.

### Official Razorpay references

- [QR Codes overview and workflow](https://razorpay.com/docs/payments/qr-codes/)
- [Create a QR Code API](https://razorpay.com/docs/api/qr-codes/create/)
- [QR Code API integration checklist](https://razorpay.com/docs/payments/qr-codes/apis/)
- [QR Code webhook events (`qr_code.credited`)](https://razorpay.com/docs/payments/qr-codes/subscribe-to-webhooks/)
- [Webhook signature validation and testing](https://razorpay.com/docs/webhooks/validate-test/)
- [Webhook best practices, retries and duplicate events](https://razorpay.com/docs/webhooks/best-practices/)

## Tests

Run the API tests with:

```bash
npm test
```

## Important production follow-up

The Android app must use the same Razorpay key mode as the Vercel environment. Keep Firestore client rules restrictive: only the backend service account should write subscription entitlement fields and verified payment records. Configure a Razorpay webhook with signature verification and duplicate-event protection to reconcile asynchronous payment/refund events.
