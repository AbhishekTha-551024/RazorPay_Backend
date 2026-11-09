'use strict';

const {
  PLAN_PRICES_INR,
  PURCHASE_ATTEMPT_COLLECTION,
  QR_CLOSE_AFTER_SECONDS,
  authenticateUser,
  isValidUuid,
  normalizePlanType,
  validRazorpayId,
} = require('../services');

function registerQrRoutes(app, { razorpayFactory, firebaseServicesFactory }) {
  app.post(['/create-qr', '/api/create-qr'], async (req, res) => {
    const planType = normalizePlanType(req.body && req.body.planType);
    const attemptId = req.get('idempotency-key');
    if (!planType) {
      return res.status(400).json({ success: false, error: 'A supported planType is required.' });
    }
    if (!isValidUuid(attemptId)) {
      return res.status(400).json({ success: false, error: 'A UUID v4 Idempotency-Key is required.' });
    }

    // Hoisted so the catch block can mark a stuck attempt as failed.
    let attemptRef = null;
    let attemptCreatedNow = false;
    let qrCreated = false;

    try {
      const services = firebaseServicesFactory();
      const user = await authenticateUser(req, services);
      if (!user || typeof user.uid !== 'string' || !user.uid) {
        return res.status(401).json({ success: false, error: 'A valid Firebase sign-in is required.' });
      }

      attemptRef = services.db.collection(PURCHASE_ATTEMPT_COLLECTION).doc(attemptId);
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
      attemptCreatedNow = true;

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
      qrCreated = true;

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
      console.error('create-qr failed:', error.code, error.message);

      // If Razorpay failed before a QR existed, don't leave the attempt stuck in "creating".
      if (attemptRef && attemptCreatedNow && !qrCreated) {
        try {
          await attemptRef.update({ state: 'failed', failedAt: Date.now() });
        } catch (updateError) {
          console.error('Could not mark attempt as failed:', updateError.message);
        }
      }

      if (error.code === 'FIREBASE_CONFIGURATION_MISSING' ||
        error.code === 'FIREBASE_CONFIGURATION_INVALID' ||
        error.code === 'PAYMENT_CONFIGURATION_MISSING') {
        return res.status(503).json({ success: false, error: 'QR payment service is not configured.' });
      }
      return res.status(502).json({ success: false, error: 'Unable to create the payment QR code.' });
    }
  });

  app.get(['/qr-status/:attemptId', '/api/qr-status/:attemptId'], async (req, res) => {
    if (!isValidUuid(req.params.attemptId)) {
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
      console.error('qr-status failed:', error.code, error.message);
      if (error.code === 'FIREBASE_CONFIGURATION_MISSING' ||
        error.code === 'FIREBASE_CONFIGURATION_INVALID') {
        return res.status(503).json({ success: false, error: 'QR payment service is not configured.' });
      }
      return res.status(502).json({ success: false, error: 'Unable to fetch purchase status.' });
    }
  });
}

module.exports = { registerQrRoutes };