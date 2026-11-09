'use strict';

const crypto = require('crypto');
const Razorpay = require('razorpay');

const PLAN_PRICES_INR = Object.freeze({
  WEEKLY: 149,
  MONTHLY: 299,
  YEARLY: 1999,
  LIFETIME: 4999,
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
let firebaseIdentity = null;

// Returns the names of required env variables that are not set.
function getMissingEnv() {
  return [
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'FIREBASE_SERVICE_ACCOUNT_JSON',
  ].filter((name) => !process.env[name]);
}

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
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
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
  const { cert, getApps, initializeApp } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getFirestore } = require('firebase-admin/firestore');
  let app = getApps()[0];

  if (!app) {
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

    // Vercel sometimes stores private_key with literal "\n" instead of real newlines.
    if (typeof serviceAccount.private_key === 'string') {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    app = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
    firebaseIdentity = {
      projectId: serviceAccount.project_id || null,
      serviceAccountEmail: serviceAccount.client_email || null,
    };
  }

  return {
    auth: getAuth(app),
    db: getFirestore(app),
    firebaseIdentity,
  };
}

function isValidUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getBearerToken(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function authenticateUser(req, firebaseServices) {
  const token = getBearerToken(req);
  if (!token) return null;
  try {
    // second argument true = also reject revoked tokens
    return await firebaseServices.auth.verifyIdToken(token, true);
  } catch (error) {
    console.error('Firebase token verification failed:', error.code || error.message);
    return null;
  }
}

function subscriptionDurationDays(planType) {
  if (planType === 'WEEKLY') return 7;
  if (planType === 'MONTHLY') return 30;
  if (planType === 'YEARLY') return 365;
  if (planType === 'LIFETIME') return 36500;
  throw new Error(`Unknown plan type: ${planType}`);
}

function planDisplayName(planType) {
  if (planType === 'WEEKLY') return 'Weekly Pass';
  if (planType === 'MONTHLY') return 'Monthly Pass';
  if (planType === 'YEARLY') return '1 Year VIP Pass';
  if (planType === 'LIFETIME') return 'Lifetime VIP Pass';
  throw new Error(`Unknown plan type: ${planType}`);
}

module.exports = {
  PLAN_PRICES_INR,
  PURCHASE_ATTEMPT_COLLECTION,
  QR_CLOSE_AFTER_SECONDS,
  WEBHOOK_EVENT_COLLECTION,
  authenticateUser,
  getFirebaseServices,
  getMissingEnv,
  getRazorpayInstance,
  isValidUuid,
  normalizePlanType,
  parseAmountInRupees,
  planDisplayName,
  signatureMatches,
  subscriptionDurationDays,
  validRazorpayId,
  webhookSignatureMatches,
};