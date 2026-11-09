'use strict';

const express = require('express');
const {
  PLAN_PRICES_INR,
  PURCHASE_ATTEMPT_COLLECTION,
  WEBHOOK_EVENT_COLLECTION,
  normalizePlanType,
  requireUuid,
  subscriptionDurationDays,
  validRazorpayId,
  webhookSignatureMatches,
} = require('../services');

function registerWebhookRoute(app, { razorpayFactory, firebaseServicesFactory }) {
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
        const planName = planType === 'WEEKLY' ? 'Weekly Pass'
          : planType === 'MONTHLY' ? 'Monthly Pass'
            : planType === 'YEARLY' ? '1 Year VIP Pass' : 'Lifetime VIP Pass';
        const orderId = typeof payment.order_id === 'string' ? payment.order_id : '';
        transaction.set(userRef(uid), {
          isPremium: true,
          isProUser: true,
          planType: planName,
          purchaseType: isLifetime ? 'lifetime' : 'subscription',
          transactionId: paymentId,
          paymentId,
          lastOrderId: orderId,
          activatedAt: purchasedAtMillis,
          lastPaymentDate: purchasedAtMillis,
          startDate,
          expiryMillis,
          premiumExpiryDate: expiryMillis,
          expiryDate,
          lastSyncedAt: nowMillis,
        }, { merge: true });
        transaction.create(transactionRef(uid), {
          orderId,
          paymentId,
          transactionId: paymentId,
          planId: planType,
          planName,
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
}

module.exports = { registerWebhookRoute };
