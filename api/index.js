require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();

// Enable CORS for all origins (allows mobile apps & web clients to connect)
app.use(cors());

// Parse incoming JSON requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Helper function to instantiate Razorpay client dynamically using env vars
 */
function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay API keys are missing. Please configure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables.');
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

// -----------------------------------------------------------------------------
// 1. Health-Check Endpoint: GET / or GET /api/test
// -----------------------------------------------------------------------------
app.get(['/', '/api/test'], (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Razorpay backend serverless function is live!",
    timestamp: new Date().toISOString(),
    envConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  });
});

// -----------------------------------------------------------------------------
// 2. Create Order Endpoint: POST /create-order or POST /api/create-order
// -----------------------------------------------------------------------------
app.post(['/create-order', '/api/create-order'], async (req, res) => {
  try {
    const { amount, currency = 'INR', receipt, notes } = req.body;

    // Input Validation
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount. "amount" must be a positive number in INR.'
      });
    }

    // Convert INR to Paise (1 INR = 100 Paise)
    const amountInPaise = Math.round(Number(amount) * 100);

    const razorpay = getRazorpayInstance();

    // Create Razorpay Order options
    const options = {
      amount: amountInPaise,
      currency: currency.toUpperCase(),
      receipt: receipt || `receipt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      notes: notes || { source: 'MagicCalculatorAndroid' }
    };

    // Call Razorpay API to generate order
    const order = await razorpay.orders.create(options);

    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      key: process.env.RAZORPAY_KEY_ID
    });

  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Razorpay order'
    });
  }
});

// -----------------------------------------------------------------------------
// 3. Verify Payment Signature Endpoint: POST /verify-payment or POST /api/verify-payment
// -----------------------------------------------------------------------------
app.post(['/verify-payment', '/api/verify-payment'], (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Validation
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        status: 'failed',
        success: false,
        message: 'Missing required parameters: razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.'
      });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({
        status: 'failed',
        success: false,
        message: 'RAZORPAY_KEY_SECRET is not configured on the server.'
      });
    }

    // Create HMAC SHA256 signature using Razorpay Key Secret
    const sign = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(sign.toString())
      .digest('hex');

    // Compare signatures
    const isAuthentic = expectedSignature === razorpay_signature;

    if (isAuthentic) {
      return res.status(200).json({
        status: 'success',
        success: true,
        message: 'Payment verified successfully',
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id
      });
    } else {
      return res.status(400).json({
        status: 'failed',
        success: false,
        message: 'Invalid payment signature. Verification failed.'
      });
    }

  } catch (error) {
    console.error('Error verifying payment:', error);
    return res.status(500).json({
      status: 'failed',
      success: false,
      message: error.message || 'Server error during payment verification'
    });
  }
});

// Start local server if file is run directly with node/nodemon
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Serverless Backend running locally on http://localhost:${PORT}`);
  });
}

// Export Express app for Vercel Serverless Function compatibility
module.exports = app;
