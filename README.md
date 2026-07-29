# Magic Calculator - Razorpay Serverless Backend (Node.js & Express on Vercel)

A production-safe, lightweight Node.js Express serverless backend ready for instant deployment to Vercel. Handles order creation and signature verification for testing and running Razorpay payments in your Android app.

---

## 📁 Project Structure

```text
razorpay-backend/
├── api/
│   └── index.js          # Express app serverless function
├── .env.example          # Environment variables template
├── package.json          # Node dependencies
├── vercel.json           # Vercel serverless routing configuration
└── README.md             # Setup & deployment guide
```

---

## 🛠️ Local Setup & Testing

### 1. Install Dependencies
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
  -d '{
    "amount": 499,
    "currency": "INR",
    "receipt": "order_receipt_123"
  }'
```
**Expected Response:**
```json
{
  "success": true,
  "orderId": "order_P1XyZ9abc123",
  "amount": 49900,
  "currency": "INR",
  "receipt": "order_receipt_123",
  "key": "rzp_test_XXXXXXXXXXXXXX"
}
```

---

### 3. Test Verify Payment Signature (`POST /api/verify-payment`)
```bash
curl -X POST https://your-vercel-app.vercel.app/api/verify-payment \
  -H "Content-Type: application/json" \
  -d '{
    "razorpay_order_id": "order_P1XyZ9abc123",
    "razorpay_payment_id": "pay_P1XyZ9paymentId",
    "razorpay_signature": "generated_hmac_sha256_signature"
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
