'use strict';

const crypto = require('crypto');
const {
  PLAN_PRICES_INR,
  authenticateUser,
  normalizePlanType,
  parseAmountInRupees,
  signatureMatches,
  subscriptionDurationDays,
  validRazorpayId,
} = require('../services');

function registerPaymentRoutes(app, { razorpayFactory, firebaseServicesFactory }) {
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
      const services = firebaseServicesFactory();
      const user = await authenticateUser(req, services);
      if (!user || typeof user.uid !== 'string' || !user.uid) {
        return res.status(401).json({ success: false, error: 'A valid Firebase sign-in is required.' });
      }

      const razorpay = razorpayFactory();
      const order = await razorpay.orders.create({
        amount: amountInRupees * 100,
        currency: 'INR',
        receipt: `mc_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`,
        payment_capture: 1,
        notes: {
          source: 'MagicCalculatorAndroid',
          planType,
          uid: user.uid,
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
      if (error.code === 'FIREBASE_CONFIGURATION_MISSING' ||
          error.code === 'FIREBASE_CONFIGURATION_INVALID') {
        return res.status(503).json({ success: false, error: 'Payment account verification is not configured.' });
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

    let services;
    try {
      services = firebaseServicesFactory();
      const user = await authenticateUser(req, services);
      if (!user || typeof user.uid !== 'string' || !user.uid) {
        return res.status(401).json({
          status: 'failed',
          success: false,
          message: 'A valid Firebase sign-in is required.',
        });
      }

      const razorpay = razorpayFactory();
      const [order, payment] = await Promise.all([
        razorpay.orders.fetch(orderId),
        razorpay.payments.fetch(paymentId),
      ]);

      const planType = normalizePlanType(order.notes && order.notes.planType);
      const orderUid = order.notes && order.notes.uid;
      const requestedPlanType = body.planType === undefined
        ? planType
        : normalizePlanType(body.planType);
      const expectedAmount = planType ? PLAN_PRICES_INR[planType] * 100 : null;
      const orderAmount = Number(order.amount);
      const paymentAmount = Number(payment.amount);
      const paidAtSeconds = Number(payment.created_at);
      const orderCurrency = typeof order.currency === 'string' ? order.currency.toUpperCase() : '';
      const paymentCurrency = typeof payment.currency === 'string' ? payment.currency.toUpperCase() : '';

      if (orderUid !== user.uid ||
          payment.order_id !== orderId ||
          payment.status !== 'captured' ||
          !planType ||
          !requestedPlanType ||
          requestedPlanType !== planType ||
          !Number.isSafeInteger(expectedAmount) ||
          orderAmount !== expectedAmount ||
          paymentAmount !== orderAmount ||
          !Number.isSafeInteger(paidAtSeconds) ||
          paidAtSeconds <= 0 ||
          orderCurrency !== 'INR' ||
          paymentCurrency !== 'INR') {
        return res.status(400).json({
          status: 'failed',
          success: false,
          message: `The payment is not valid or does not match the order. Payment status: ${payment.status}`,
        });
      }

      const activatedAt = paidAtSeconds * 1000;
      const durationDays = subscriptionDurationDays(planType);
      const isLifetime = planType === 'LIFETIME';
      const expiryMillis = isLifetime
        ? 0
        : activatedAt + durationDays * 24 * 60 * 60 * 1000;
      const planName = planType === 'WEEKLY' ? 'Weekly Pass'
        : planType === 'MONTHLY' ? 'Monthly Pass'
          : planType === 'YEARLY' ? '1 Year VIP Pass' : 'Lifetime VIP Pass';
      const purchaseType = isLifetime ? 'lifetime' : 'subscription';
      const startDate = new Date(activatedAt).toISOString();
      const expiryDate = isLifetime
        ? 'Never Expires (Lifetime Access)'
        : new Date(expiryMillis).toISOString();
      const userRef = services.db.collection('users').doc(user.uid);
      const transactionRef = userRef.collection('transactions').doc(paymentId);
      const entitlement = await services.db.runTransaction(async (transaction) => {
        const existingPayment = await transaction.get(transactionRef);
        const transactionData = {
          orderId,
          paymentId,
          transactionId: paymentId,
          planId: planType,
          planName,
          amount: paymentAmount / 100,
          currency: paymentCurrency,
          method: payment.method || 'unknown',
          status: 'SUCCESS',
          timestamp: activatedAt,
          activatedAt,
          startDate,
          expiryMillis,
          expiryDate,
          purchaseType,
        };

        if (existingPayment.exists) {
          const previous = existingPayment.data();
          if (previous.orderId !== orderId ||
              previous.paymentId !== paymentId ||
              previous.planId !== planType ||
              Number(previous.amount) !== paymentAmount / 100 ||
              previous.currency !== paymentCurrency) {
            const error = new Error('Payment record does not match the verified order.');
            error.code = 'PAYMENT_RECORD_CONFLICT';
            throw error;
          }
        }

        transaction.set(userRef, {
          isPremium: true,
          isProUser: true,
          planType: planName,
          purchaseType,
          transactionId: paymentId,
          paymentId,
          lastOrderId: orderId,
          activatedAt,
          lastPaymentDate: activatedAt,
          startDate,
          expiryMillis,
          premiumExpiryDate: expiryMillis,
          expiryDate,
          lastSyncedAt: Date.now(),
        }, { merge: true });
        transaction.set(transactionRef, transactionData, { merge: true });
        return { activatedAt, expiryMillis, purchaseType };
      });

      return res.status(200).json({
        status: 'success',
        success: true,
        message: 'Payment verified successfully',
        paymentId,
        orderId,
        planType,
        amount: paymentAmount,
        currency: paymentCurrency,
        activatedAt: entitlement.activatedAt,
        expiryMillis: entitlement.expiryMillis,
        purchaseType: entitlement.purchaseType,
      });
    } catch (error) {
      if (error.code === 'PAYMENT_CONFIGURATION_MISSING') {
        return res.status(503).json({
          status: 'failed',
          success: false,
          message: 'Payment service is not configured.',
        });
      }
      if (error.code === 'FIREBASE_CONFIGURATION_MISSING' ||
          error.code === 'FIREBASE_CONFIGURATION_INVALID') {
        return res.status(503).json({
          status: 'failed',
          success: false,
          message: 'Premium activation is not configured.',
        });
      }
      if (error.code === 'PAYMENT_RECORD_CONFLICT') {
        return res.status(409).json({
          status: 'failed',
          success: false,
          message: 'This payment is already associated with a different order.',
        });
      }
      if (error.code === 7 || error.code === '7' || error.code === 'PERMISSION_DENIED') {
        console.error('Firestore denied Premium activation.', {
          firebaseProjectId: services && services.firebaseIdentity
            ? services.firebaseIdentity.projectId
            : null,
          firebaseServiceAccount: services && services.firebaseIdentity
            ? services.firebaseIdentity.serviceAccountEmail
            : null,
          errorCode: error.code,
        });
        return res.status(503).json({
          status: 'failed',
          success: false,
          message: 'Payment was received, but Firestore permissions blocked Premium activation. Do not pay again; retry verification after the server permissions are fixed.',
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
}

module.exports = { registerPaymentRoutes };
