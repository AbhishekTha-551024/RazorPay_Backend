'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const PLAN_PRICES_INR = Object.freeze({
  WEEKLY: 149,
  MONTHLY: 299,
  YEARLY: 1999,
  LIFETIME: 1999,
});

const PLAN_ALIASES = Object.freeze({
  'WEEKLY PASS': 'WEEKLY',
  'MONTHLY PASS': 'MONTHLY',
  '1 YEAR VIP PASS': 'YEARLY',
  'LIFETIME VIP PASS': 'LIFETIME',
});

const PLAN_CODES = new Set(Object.keys(PLAN_PRICES_INR));
const PURCHASE_ATTEMPT_COLLECTION = 'qrPurchaseAttempts';
const WEBHOOK_EVENT_COLLECTION = 'razorpayWebhookEvents';
const QR_CLOSE_AFTER_SECONDS = 20 * 60;

function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    const error = new Error('Razorpay credentials are not configured.');
    error.code = 'PAYMENT_CONFIGURATION_MISSING';
    throw error;
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

function normalizePlanType(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, ' ');
  if (PLAN_CODES.has(normalized)) return normalized;
  return PLAN_ALIASES[normalized] || null;
}

function parseAmountInRupees(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validRazorpayId(value, prefix) {
  return typeof value === 'string' &&
    value.length <= 64 &&
    new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
}

function signatureMatches(orderId, paymentId, signature, keySecret) {
  if (typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`, 'utf8')
    .digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

function webhookSignatureMatches(rawBody, signature, webhookSecret) {
  if (!Buffer.isBuffer(rawBody) ||
      typeof signature !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

function getFirebaseServices() {
  const admin = require('firebase-admin');
  if (admin.apps.length === 0) {
    const serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountValue) {
      const error = new Error('Firebase Admin credentials are not configured.');
      error.code = 'FIREBASE_CONFIGURATION_MISSING';
      throw error;
    }

    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountValue);
    } catch (cause) {
      const error = new Error('Firebase Admin service account JSON is invalid.');
      error.code = 'FIREBASE_CONFIGURATION_INVALID';
      error.cause = cause;
      throw error;
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  return {
    auth: admin.auth(),
    db: admin.firestore(),
  };
}

function requireUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getBearerToken(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  return match ? match[1] : null;
}

async function authenticateUser(req, firebaseServices) {
  const token = getBearerToken(req);
  if (!token) return null;
  try {
    return await firebaseServices.auth.verifyIdToken(token);
  } catch (error) {
    return null;
  }
}

function subscriptionDurationDays(planType) {
  if (planType === 'WEEKLY') return 7;
  if (planType === 'MONTHLY') return 30;
  if (planType === 'YEARLY') return 365;
  return 36500;
}

function createApp({ razorpayFactory = getRazorpayInstance, firebaseServicesFactory = getFirebaseServices } = {}) {
  const app = express();
  const allowedOrigins = new Set(
    (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );

  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS.'));
    },
  }));

  app.post(['/razorpay/webhook', '/api/razorpay/webhook'], express.raw({
    type: 'application/json',
    limit: '64kb',
  }), async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(503).json({ success: false, error: 'Webhook is not configured.' });
    }

    const signature = req.get('x-razorpay-signature');
    const eventId = req.get('x-razorpay-event-id');
    if (!webhookSignatureMatches(req.body, signature, webhookSecret)) {
      return res.status(400).json({ success: false, error: 'Invalid webhook signature.' });
    }
    if (typeof eventId !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(eventId)) {
      return res.status(400).json({ success: false, error: 'Valid Razorpay event ID is required.' });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch (error) {
      return res.status(400).json({ success: false, error: 'Webhook body contains invalid JSON.' });
    }
    if (!event || event.event !== 'qr_code.credited') {
      return res.status(200).json({ success: true, ignored: true });
    }

    const paymentPayload = event.payload && event.payload.payment && event.payload.payment.entity;
    const qrPayload = event.payload && event.payload.qr_code && event.payload.qr_code.entity;
    const qrCodeId = qrPayload && qrPayload.id;
    const paymentId = paymentPayload && paymentPayload.id;
    if (!validRazorpayId(qrCodeId, 'qr') || !validRazorpayId(paymentId, 'pay')) {
      return res.status(400).json({ success: false, error: 'Webhook is missing valid QR/payment IDs.' });
    }

    try {
      const services = firebaseServicesFactory();
      const razorpay = razorpayFactory();
      const [qr, payment] = await Promise.all([
        razorpay.qrCode.fetch(qrCodeId),
        razorpay.payments.fetch(paymentId),
      ]);
      const purchaseAttemptId = qr.notes && qr.notes.purchaseAttemptId;
      const planType = normalizePlanType(qr.notes && qr.notes.planType);
      const expectedAmount = planType ? PLAN_PRICES_INR[planType] * 100 : null;
      const paymentAmount = Number(payment.amount);
      const qrAmount = Number(qr.payment_amount);
      const closeBy = Number(qr.close_by);
      const qrCreatedAt = Number(qr.created_at);
      const paymentCreatedAt = Number(payment.created_at);
      const paymentIsCaptured = payment.status === 'captured' && payment.captured === true;

      if (!requireUuid(purchaseAttemptId) ||
          qr.id !== qrCodeId ||
          qr.type !== 'upi_qr' ||
          qr.usage !== 'single_use' ||
          qr.fixed_amount !== true ||
          !planType ||
          !Number.isSafeInteger(expectedAmount) ||
          qrAmount !== expectedAmount ||
          paymentIsCaptured !== true ||
          payment.method !== 'upi' ||
          payment.currency !== 'INR' ||
          paymentAmount !== expectedAmount ||
          !Number.isFinite(closeBy) ||
          !Number.isFinite(qrCreatedAt) ||
          !Number.isFinite(paymentCreatedAt) ||
          paymentCreatedAt < qrCreatedAt ||
          paymentCreatedAt > closeBy) {
        console.error('Rejected QR payment webhook due to a QR/payment mismatch.', {
          eventId,
          qrCodeId,
          paymentId,
        });
        return res.status(200).json({ success: true, ignored: true });
      }

      const attemptRef = services.db.collection(PURCHASE_ATTEMPT_COLLECTION).doc(purchaseAttemptId);
      const eventRef = services.db.collection(WEBHOOK_EVENT_COLLECTION).doc(eventId);
      const userRef = (uid) => services.db.collection('users').doc(uid);
      const transactionRef = (uid) =>
        services.db.collection('users').doc(uid).collection('transactions').doc(paymentId);
      const nowMillis = Date.now();
      const purchasedAtMillis = paymentCreatedAt * 1000;
      const durationDays = subscriptionDurationDays(planType);
      const isLifetime = planType === 'LIFETIME';
      const expiryMillis = isLifetime
        ? 0
        : purchasedAtMillis + durationDays * 24 * 60 * 60 * 1000;
      const startDate = new Date(purchasedAtMillis).toISOString();
      const expiryDate = isLifetime
        ? 'Never Expires (Lifetime Access)'
        : new Date(expiryMillis).toISOString();

      const result = await services.db.runTransaction(async (transaction) => {
        const [eventSnapshot, attemptSnapshot] = await Promise.all([
          transaction.get(eventRef),
          transaction.get(attemptRef),
        ]);
        if (eventSnapshot.exists) return 'duplicate';
        if (!attemptSnapshot.exists) {
          transaction.create(eventRef, {
            event: event.event,
            paymentId,
            qrCodeId,
            state: 'ignored',
            receivedAt: nowMillis,
            reason: 'purchase_attempt_missing',
          });
          return 'ignored';
        }

        const attempt = attemptSnapshot.data();
        if (attempt.state === 'paid') {
          transaction.create(eventRef, {
            event: event.event,
            paymentId,
            qrCodeId,
            purchaseAttemptId,
            state: 'duplicate_payment',
            receivedAt: nowMillis,
          });
          return 'duplicate';
        }
        if (attempt.state !== 'pending' ||
            attempt.qrCodeId !== qrCodeId ||
            Number(attempt.expiresAt) !== closeBy ||
            attempt.uid !== (qr.notes && qr.notes.uid) ||
            attempt.planType !== planType ||
            attempt.amount !== expectedAmount) {
          transaction.create(eventRef, {
            event: event.event,
            paymentId,
            qrCodeId,
            purchaseAttemptId,
            state: 'ignored',
            receivedAt: nowMillis,
            reason: 'purchase_attempt_mismatch',
          });
          return 'ignored';
        }

        const uid = attempt.uid;
        transaction.set(userRef(uid), {
          isPremium: true,
          isProUser: true,
          planType: planType === 'WEEKLY' ? 'Weekly Pass'
            : planType === 'MONTHLY' ? 'Monthly Pass'
              : planType === 'YEARLY' ? '1 Year VIP Pass' : 'Lifetime VIP Pass',
          purchaseType: isLifetime ? 'lifetime' : 'subscription',
          transactionId: paymentId,
          paymentId,
          lastOrderId: typeof payment.order_id === 'string' ? payment.order_id : '',
          activatedAt: purchasedAtMillis,
          lastPaymentDate: purchasedAtMillis,
          startDate,
          expiryMillis,
          premiumExpiryDate: expiryMillis,
          expiryDate,
          lastSyncedAt: nowMillis,
        }, { merge: true });
        transaction.create(transactionRef(uid), {
          orderId: typeof payment.order_id === 'string' ? payment.order_id : '',
          paymentId,
          transactionId: paymentId,
          planId: planType,
          planName: planType === 'WEEKLY' ? 'Weekly Pass'
            : planType === 'MONTHLY' ? 'Monthly Pass'
              : planType === 'YEARLY' ? '1 Year VIP Pass' : 'Lifetime VIP Pass',
          amount: expectedAmount / 100,
          currency: 'INR',
          method: 'UPI QR',
          status: 'SUCCESS',
          timestamp: purchasedAtMillis,
          activatedAt: purchasedAtMillis,
          startDate,
          expiryMillis,
          expiryDate,
          purchaseType: isLifetime ? 'lifetime' : 'subscription',
          qrCodeId,
          purchaseAttemptId,
        });
        transaction.update(attemptRef, {
          state: 'paid',
          paymentId,
          paidAt: nowMillis,
        });
        transaction.create(eventRef, {
          event: event.event,
          paymentId,
          qrCodeId,
          purchaseAttemptId,
          state: 'processed',
          receivedAt: nowMillis,
        });
        return 'processed';
      });

      return res.status(200).json({ success: true, state: result });
    } catch (error) {
      if (error.code === 'FIREBASE_CONFIGURATION_MISSING' ||
          error.code === 'FIREBASE_CONFIGURATION_INVALID' ||
          error.code === 'PAYMENT_CONFIGURATION_MISSING') {
        return res.status(503).json({ success: false, error: 'Payment confirmation is not configured.' });
      }
      console.error('Error processing Razorpay QR webhook:', error);
      return res.status(500).json({ success: false, error: 'Unable to process payment notification.' });
    }
  });

  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));

  app.get(['/', '/api/test'], (req, res) => res.status(200).json({
    success: true,
    message: 'Razorpay backend serverless function is live!',
    timestamp: new Date().toISOString(),
    envConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
  }));

  app.post(['/create-qr', '/api/create-qr'], async (req, res) => {
    const planType = normalizePlanType(req.body && req.body.planType);
    const attemptId = req.get('idempotency-key');
    if (!planType) {
      return res.status(400).json({ success: false, error: 'A supported planType is required.' });
    }
    if (!requireUuid(attemptId)) {
      return res.status(400).json({ success: false, error: 'A UUID v4 Idempotency-Key is required.' });
    }

    try {
      const services = firebaseServicesFactory();
      const user = await authenticateUser(req, services);
      if (!user || typeof user.uid !== 'string' || !user.uid) {
        return res.status(401).json({ success: false, error: 'A valid Firebase sign-in is required.' });
      }

      const attemptRef = services.db.collection(PURCHASE_ATTEMPT_COLLECTION).doc(attemptId);
      const nowMillis = Date.now();
      const existing = await services.db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(attemptRef);
        if (snapshot.exists) {
          const current = snapshot.data();
          if (current.uid !== user.uid || current.planType !== planType) {
            return { conflict: true };
          }
          return { attempt: current };
        }

        const attempt = {
          uid: user.uid,
          planType,
          amount: PLAN_PRICES_INR[planType] * 100,
          state: 'creating',
          createdAt: nowMillis,
        };
        transaction.create(attemptRef, attempt);
        return { attempt, created: true };
      });

      if (existing.conflict) {
        return res.status(409).json({ success: false, error: 'Idempotency key already belongs to another request.' });
      }
      if (!existing.created) {
        const attempt = existing.attempt;
        if (attempt.state === 'pending' || attempt.state === 'paid') {
          return res.status(200).json({
            success: true,
            attemptId,
            status: attempt.state,
            qrCodeId: attempt.qrCodeId,
            imageUrl: attempt.imageUrl,
            planType: attempt.planType,
            amount: attempt.amount,
            currency: 'INR',
            expiresAt: attempt.expiresAt,
          });
        }
        return res.status(409).json({
          success: false,
          error: 'This purchase attempt is already being created or cannot be retried. Start a new attempt.',
        });
      }

      const expiresAt = Math.floor(Date.now() / 1000) + QR_CLOSE_AFTER_SECONDS;
      const qr = await razorpayFactory().qrCode.create({
        type: 'upi_qr',
        name: `Premium ${planType}`,
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: PLAN_PRICES_INR[planType] * 100,
        description: `Magic Calculator ${planType}`,
        close_by: expiresAt,
        notes: {
          uid: user.uid,
          planType,
          purchaseAttemptId: attemptId,
        },
      });

      if (!validRazorpayId(qr.id, 'qr') ||
          typeof qr.image_url !== 'string' ||
          !qr.image_url.startsWith('https://') ||
          qr.type !== 'upi_qr' ||
          qr.usage !== 'single_use' ||
          qr.fixed_amount !== true ||
          Number(qr.payment_amount) !== PLAN_PRICES_INR[planType] * 100) {
        throw new Error('Razorpay returned an invalid QR code response.');
      }

      const responseData = {
        qrCodeId: qr.id,
        imageUrl: qr.image_url,
        expiresAt: Number(qr.close_by) || expiresAt,
        state: 'pending',
      };
      await attemptRef.update(responseData);
      return res.status(200).json({
        success: true,
        attemptId,
        status: 'pending',
        ...responseData,
        planType,
        amount: PLAN_PRICES_INR[planType] * 100,
        currency: 'INR',
      });
    } catch (error) {
      if (error.code === 'FIREBASE_CONFIGURATION_MISSING' ||
          error.code === 'FIREBASE_CONFIGURATION_INVALID' ||
          error.code === 'PAYMENT_CONFIGURATION_MISSING') {
        return res.status(503).json({ success: false, error: 'QR payment service is not configured.' });
      }
      console.error('Error creating Razorpay QR code:', error);
      return res.status(502).json({ success: false, error: 'Unable to create the payment QR code.' });
    }
  });

  app.get(['/qr-status/:attemptId', '/api/qr-status/:attemptId'], async (req, res) => {
    if (!requireUuid(req.params.attemptId)) {
      return res.status(400).json({ success: false, error: 'A valid purchase attempt ID is required.' });
    }
    try {
      const services = firebaseServicesFactory();
      const user = await authenticateUser(req, services);
      if (!user || typeof user.uid !== 'string' || !user.uid) {
        return res.status(401).json({ success: false, error: 'A valid Firebase sign-in is required.' });
      }
      const attemptRef = services.db.collection(PURCHASE_ATTEMPT_COLLECTION).doc(req.params.attemptId);
      const snapshot = await attemptRef.get();
      if (!snapshot.exists || snapshot.data().uid !== user.uid) {
        return res.status(404).json({ success: false, error: 'Purchase attempt was not found.' });
      }

      const attempt = snapshot.data();
      const isExpired = attempt.state === 'pending' &&
        Number.isFinite(attempt.expiresAt) &&
        Math.floor(Date.now() / 1000) >= attempt.expiresAt;
      return res.status(200).json({
        success: true,
        attemptId: req.params.attemptId,
        status: isExpired ? 'expired' : attempt.state,
        planType: attempt.planType,
        amount: attempt.amount,
        currency: 'INR',
        qrCodeId: attempt.qrCodeId,
        imageUrl: attempt.imageUrl,
        expiresAt: attempt.expiresAt,
        paymentId: attempt.paymentId,
      });
    } catch (error) {
      if (error.code === 'FIREBASE_CONFIGURATION_MISSING' ||
          error.code === 'FIREBASE_CONFIGURATION_INVALID') {
        return res.status(503).json({ success: false, error: 'QR payment service is not configured.' });
      }
      console.error('Error fetching QR purchase status:', error);
      return res.status(502).json({ success: false, error: 'Unable to fetch purchase status.' });
    }
  });

  app.post(['/create-order', '/api/create-order'], async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: 'A JSON request body is required.' });
    }

    const planType = normalizePlanType(body.planType);
    if (!planType) {
      return res.status(400).json({ success: false, error: 'A supported planType is required.' });
    }

    const amountInRupees = parseAmountInRupees(body.amount);
    if (amountInRupees !== PLAN_PRICES_INR[planType]) {
      return res.status(400).json({
        success: false,
        error: `The amount does not match the ${planType} plan price.`,
      });
    }

    if (body.currency !== undefined && body.currency !== 'INR') {
      return res.status(400).json({ success: false, error: 'Only INR payments are supported.' });
    }

    try {
      const razorpay = razorpayFactory();
      const order = await razorpay.orders.create({
        amount: amountInRupees * 100,
        currency: 'INR',
        receipt: `mc_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`,
        payment_capture: 1, // Auto-capture immediately on payment success
        notes: {
          source: 'MagicCalculatorAndroid',
          planType,
        },
      });

      return res.status(200).json({
        success: true,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
        key: process.env.RAZORPAY_KEY_ID || undefined,
      });
    } catch (error) {
      if (error.code === 'PAYMENT_CONFIGURATION_MISSING') {
        return res.status(503).json({ success: false, error: 'Payment service is not configured.' });
      }
      console.error('Error creating Razorpay order:', error);
      return res.status(502).json({ success: false, error: 'Unable to create the payment order.' });
    }
  });

  app.post(['/verify-payment', '/api/verify-payment'], async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        status: 'failed',
        success: false,
        message: 'A JSON request body is required.',
      });
    }

    const orderId = body.razorpay_order_id;
    const paymentId = body.razorpay_payment_id;
    const signature = body.razorpay_signature;
    if (!validRazorpayId(orderId, 'order') ||
        !validRazorpayId(paymentId, 'pay') ||
        typeof signature !== 'string' ||
        !/^[a-fA-F0-9]{64}$/.test(signature)) {
      return res.status(400).json({
        status: 'failed',
        success: false,
        message: 'Valid Razorpay order, payment, and signature values are required.',
      });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(503).json({
        status: 'failed',
        success: false,
        message: 'Payment service is not configured.',
      });
    }

    if (!signatureMatches(orderId, paymentId, signature, keySecret)) {
      return res.status(400).json({
        status: 'failed',
        success: false,
        message: 'Payment signature verification failed.',
      });
    }

    try {
      const razorpay = razorpayFactory();
      const [order, payment] = await Promise.all([
        razorpay.orders.fetch(orderId),
        razorpay.payments.fetch(paymentId),
      ]);

      const planType = normalizePlanType(order.notes && order.notes.planType);
      const requestedPlanType = body.planType === undefined
        ? planType
        : normalizePlanType(body.planType);
      const expectedAmount = planType ? PLAN_PRICES_INR[planType] * 100 : null;
      const orderAmount = Number(order.amount);
      const paymentAmount = Number(payment.amount);
      const orderCurrency = typeof order.currency === 'string' ? order.currency.toUpperCase() : '';
      const paymentCurrency = typeof payment.currency === 'string' ? payment.currency.toUpperCase() : '';

      // Accept both 'captured' (auto-capture) and 'authorized' (manual capture).
      // For UPI intent payments the status can briefly be 'authorized' before capture.
      const paymentIsValid = payment.status === 'captured' || payment.status === 'authorized';

      if (payment.order_id !== orderId ||
          !paymentIsValid ||
          !planType ||
          !requestedPlanType ||
          requestedPlanType !== planType ||
          !Number.isSafeInteger(expectedAmount) ||
          orderAmount !== expectedAmount ||
          paymentAmount !== orderAmount ||
          orderCurrency !== 'INR' ||
          paymentCurrency !== 'INR') {
        return res.status(400).json({
          status: 'failed',
          success: false,
          message: `The payment is not valid or does not match the order. Payment status: ${payment.status}`,
        });
      }

      return res.status(200).json({
        status: 'success',
        success: true,
        message: 'Payment verified successfully',
        paymentId,
        orderId,
        planType,
        amount: paymentAmount,
        currency: paymentCurrency,
      });
    } catch (error) {
      if (error.code === 'PAYMENT_CONFIGURATION_MISSING') {
        return res.status(503).json({
          status: 'failed',
          success: false,
          message: 'Payment service is not configured.',
        });
      }
      console.error('Error confirming Razorpay payment:', error);
      return res.status(502).json({
        status: 'failed',
        success: false,
        message: 'Unable to confirm the payment with Razorpay.',
      });
    }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large'
      ? 413
      : error.type === 'entity.parse.failed'
        ? 400
        : error.message === 'Origin is not allowed by CORS.'
          ? 403
          : 500;
    return res.status(status).json({
      success: false,
      error: status === 413
        ? 'Request body is too large.'
        : status === 400
          ? 'Request body contains invalid JSON.'
          : status === 403
            ? 'Origin is not allowed.'
            : 'Internal server error.',
    });
  });

  return app;
}

const app = createApp();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Razorpay backend listening on port ${port}.`);
  });
}

module.exports = app;
module.exports.createApp = createApp;
