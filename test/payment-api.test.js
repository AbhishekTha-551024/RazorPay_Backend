'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const appModule = require('../api/index');

const { createApp } = appModule;
process.env.RAZORPAY_KEY_ID = 'rzp_test_id';
process.env.RAZORPAY_KEY_SECRET = 'test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook-secret';

const orderId = 'order_TestOrder123';
const paymentId = 'pay_TestPayment123';
const firebaseToken = 'valid-firebase-token';

function createSignature(id = orderId, payment = paymentId) {
  return crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${id}|${payment}`)
    .digest('hex');
}

async function startServer(t, razorpay, db = createMemoryFirestore()) {
  const app = createApp({
    razorpayFactory: () => razorpay,
    firebaseServicesFactory: () => ({
      auth: {
        verifyIdToken: async (token) => {
          if (token !== firebaseToken) throw new Error('Invalid token.');
          return { uid: 'user-123' };
        },
      },
      db,
    }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    if (server.closeAllConnections) server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function authHeaders() {
  return { authorization: `Bearer ${firebaseToken}` };
}

function createMemoryFirestore() {
  const documents = new Map();
  function makeRef(path) {
    return {
      path,
      collection(name) {
        return makeCollection(`${path}/${name}`);
      },
      async get() {
        return makeSnapshot(documents.get(path));
      },
      async update(data) {
        if (!documents.has(path)) throw new Error('Document does not exist.');
        documents.set(path, { ...documents.get(path), ...data });
      },
      async set(data, options = {}) {
        documents.set(path, options.merge
          ? { ...documents.get(path), ...data }
          : { ...data });
      },
    };
  }
  function makeCollection(path) {
    return { doc: (id) => makeRef(`${path}/${id}`) };
  }
  function makeSnapshot(data) {
    return {
      exists: data !== undefined,
      data: () => data,
    };
  }

  return {
    collection: makeCollection,
    async runTransaction(callback) {
      const transaction = {
        get: async (ref) => makeSnapshot(documents.get(ref.path)),
        create(ref, data) {
          if (documents.has(ref.path)) throw new Error('Document already exists.');
          documents.set(ref.path, { ...data });
        },
        set(ref, data, options = {}) {
          documents.set(ref.path, options.merge
            ? { ...documents.get(ref.path), ...data }
            : { ...data });
        },
        update(ref, data) {
          if (!documents.has(ref.path)) throw new Error('Document does not exist.');
          documents.set(ref.path, { ...documents.get(ref.path), ...data });
        },
      };
      return callback(transaction);
    },
    documents,
  };
}

async function startQrServer(t, razorpay, db = createMemoryFirestore()) {
  const app = createApp({
    razorpayFactory: () => razorpay,
    firebaseServicesFactory: () => ({
      auth: {
        verifyIdToken: async (token) => {
          if (token !== 'valid-firebase-token') throw new Error('Invalid token.');
          return { uid: 'user-123' };
        },
      },
      db,
    }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    if (server.closeAllConnections) server.closeAllConnections();
  }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db };
}

async function postJson(baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function postRawWebhook(baseUrl, event, eventId = 'evt_TestEvent123', signatureOverride) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const signature = signatureOverride || crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const response = await fetch(`${baseUrl}/api/razorpay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body: rawBody,
  });
  return { response, body: await response.json() };
}

test('create order rejects unrecognized plans and client-selected prices', async (t) => {
  let razorpayCalls = 0;
  const baseUrl = await startServer(t, {
    orders: {
      create: async () => {
        razorpayCalls += 1;
        throw new Error('Must not create an order.');
      },
    },
  });

  const unknownPlan = await postJson(baseUrl, '/api/create-order', {
    planType: 'SPECIAL',
    amount: 1,
  });
  assert.equal(unknownPlan.response.status, 400);

  const mismatchedAmount = await postJson(baseUrl, '/api/create-order', {
    planType: 'WEEKLY',
    amount: 1,
  });
  assert.equal(mismatchedAmount.response.status, 400);
  assert.equal(razorpayCalls, 0);
});

test('create order requires an authenticated Firebase user', async (t) => {
  let razorpayCalls = 0;
  const baseUrl = await startServer(t, {
    orders: {
      create: async () => {
        razorpayCalls += 1;
        return { id: orderId };
      },
    },
  });

  const result = await postJson(baseUrl, '/api/create-order', {
    planType: 'WEEKLY',
    amount: 149,
    currency: 'INR',
  });
  assert.equal(result.response.status, 401);
  assert.equal(razorpayCalls, 0);
});

test('create order uses the configured catalog price and plan metadata', async (t) => {
  let createdOrder;
  const db = createMemoryFirestore();
  const baseUrl = await startServer(t, {
    orders: {
      create: async (options) => {
        createdOrder = options;
        return {
          id: orderId,
          amount: options.amount,
          currency: options.currency,
          receipt: options.receipt,
        };
      },
    },
  }, db);

  const result = await postJson(baseUrl, '/api/create-order', {
    planType: 'Weekly Pass',
    amount: 149,
    currency: 'INR',
  }, authHeaders());

  assert.equal(result.response.status, 200);
  assert.equal(result.body.orderId, orderId);
  assert.equal(createdOrder.amount, 14900);
  assert.equal(createdOrder.currency, 'INR');
  assert.equal(createdOrder.notes.planType, 'WEEKLY');
  assert.equal(createdOrder.notes.uid, 'user-123');
  assert.match(createdOrder.receipt, /^mc_\d+_[a-f0-9]{16}$/);
});

test('verify requires a captured payment matching the signed order and plan', async (t) => {
  const db = createMemoryFirestore();
  const baseUrl = await startServer(t, {
    orders: {
      fetch: async (id) => ({
        id,
        amount: 14900,
        currency: 'INR',
        notes: { planType: 'WEEKLY', uid: 'user-123' },
      }),
    },
    payments: {
      fetch: async (id) => ({
        id,
        order_id: orderId,
        amount: 14900,
        currency: 'INR',
        status: 'captured',
        captured: true,
        method: 'upi',
        created_at: 1_800_000_000,
      }),
    },
  }, db);

  const result = await postJson(baseUrl, '/api/verify-payment', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: createSignature(),
    planType: 'WEEKLY',
  }, authHeaders());

  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.planType, 'WEEKLY');
  assert.equal(result.body.amount, 14900);
  assert.equal(result.body.activatedAt, 1_800_000_000_000);
  assert.equal(result.body.expiryMillis, 1_800_000_000_000 + 7 * 24 * 60 * 60 * 1000);
  assert.equal(db.documents.get('users/user-123').isPremium, true);
  assert.equal(db.documents.get('users/user-123').expiryMillis, result.body.expiryMillis);
  assert.equal(db.documents.get(`users/user-123/transactions/${paymentId}`).orderId, orderId);

  const retry = await postJson(baseUrl, '/api/verify-payment', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: createSignature(),
    planType: 'WEEKLY',
  }, authHeaders());
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.expiryMillis, result.body.expiryMillis);
});

test('verify reports Firestore permission failures without implying Razorpay rejected payment', async (t) => {
  const db = createMemoryFirestore();
  db.runTransaction = async () => {
    const error = new Error('Missing or insufficient permissions.');
    error.code = 7;
    throw error;
  };
  const baseUrl = await startServer(t, {
    orders: {
      fetch: async (id) => ({
        id,
        amount: 14900,
        currency: 'INR',
        notes: { planType: 'WEEKLY', uid: 'user-123' },
      }),
    },
    payments: {
      fetch: async (id) => ({
        id,
        order_id: orderId,
        amount: 14900,
        currency: 'INR',
        status: 'captured',
        captured: true,
        created_at: 1_800_000_000,
      }),
    },
  }, db);

  const result = await postJson(baseUrl, '/api/verify-payment', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: createSignature(),
    planType: 'WEEKLY',
  }, authHeaders());

  assert.equal(result.response.status, 503);
  assert.equal(result.body.success, false);
  assert.match(result.body.message, /Firestore permissions blocked Premium activation/);
  assert.match(result.body.message, /Do not pay again/);
});

test('verify requires the authenticated Firebase user to own the Razorpay order', async (t) => {
  const db = createMemoryFirestore();
  const baseUrl = await startServer(t, {
    orders: {
      fetch: async (id) => ({
        id,
        amount: 14900,
        currency: 'INR',
        notes: { planType: 'WEEKLY', uid: 'another-user' },
      }),
    },
    payments: {
      fetch: async (id) => ({
        id,
        order_id: orderId,
        amount: 14900,
        currency: 'INR',
        status: 'captured',
        captured: true,
        created_at: 1_800_000_000,
      }),
    },
  }, db);

  const result = await postJson(baseUrl, '/api/verify-payment', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: createSignature(),
    planType: 'WEEKLY',
  }, authHeaders());

  assert.equal(result.response.status, 400);
  assert.equal(result.body.success, false);
  assert.equal(db.documents.size, 0);
});

test('verify rejects invalid signatures before calling Razorpay', async (t) => {
  let fetchCalls = 0;
  const baseUrl = await startServer(t, {
    orders: { fetch: async () => { fetchCalls += 1; } },
    payments: { fetch: async () => { fetchCalls += 1; } },
  });

  const result = await postJson(baseUrl, '/api/verify-payment', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: '0'.repeat(64),
    planType: 'WEEKLY',
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.success, false);
  assert.equal(fetchCalls, 0);
});

test('verify rejects authorized rather than captured payments', async (t) => {
  const baseUrl = await startServer(t, {
    orders: {
      fetch: async (id) => ({
        id,
        amount: 14900,
        currency: 'INR',
        notes: { planType: 'WEEKLY', uid: 'user-123' },
      }),
    },
    payments: {
      fetch: async (id) => ({
        id,
        order_id: orderId,
        amount: 14900,
        currency: 'INR',
        status: 'authorized',
        captured: false,
      }),
    },
  });

  const result = await postJson(baseUrl, '/api/verify-payment', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: createSignature(),
    planType: 'WEEKLY',
  }, authHeaders());

  assert.equal(result.response.status, 400);
  assert.equal(result.body.success, false);
});

test('verify rejects payments whose order or amount does not match', async (t) => {
  const baseUrl = await startServer(t, {
    orders: {
      fetch: async (id) => ({
        id,
        amount: 14900,
        currency: 'INR',
        notes: { planType: 'WEEKLY', uid: 'user-123' },
      }),
    },
    payments: {
      fetch: async (id) => ({
        id,
        order_id: 'order_DifferentOrder',
        amount: 29900,
        currency: 'INR',
        status: 'captured',
        captured: true,
      }),
    },
  });

  const result = await postJson(baseUrl, '/api/verify-payment', {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: createSignature(),
    planType: 'WEEKLY',
  }, authHeaders());

  assert.equal(result.response.status, 400);
  assert.equal(result.body.success, false);
});

test('create QR requires Firebase auth and a UUID idempotency key', async (t) => {
  const { baseUrl } = await startQrServer(t, { qrCode: { create: async () => assert.fail() } });
  const result = await postJson(baseUrl, '/api/create-qr', { planType: 'WEEKLY' });
  assert.equal(result.response.status, 400);

  const unauthenticated = await fetch(`${baseUrl}/api/create-qr`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': '4c027c3b-61d5-4e31-b488-5500045b5c82',
    },
    body: JSON.stringify({ planType: 'WEEKLY' }),
  });
  assert.equal(unauthenticated.status, 401);
});

test('create QR uses server price and stores an authenticated pending attempt', async (t) => {
  let createdQr;
  let qrCreateCalls = 0;
  const { baseUrl, db } = await startQrServer(t, {
    qrCode: {
      create: async (options) => {
        qrCreateCalls += 1;
        createdQr = options;
        return {
          id: 'qr_TestQr123',
          image_url: 'https://rzp.io/i/test',
          type: 'upi_qr',
          usage: 'single_use',
          fixed_amount: true,
          payment_amount: options.payment_amount,
          close_by: options.close_by,
        };
      },
    },
  });
  const attemptId = '4c027c3b-61d5-4e31-b488-5500045b5c82';
  const response = await fetch(`${baseUrl}/api/create-qr`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer valid-firebase-token',
      'idempotency-key': attemptId,
    },
    body: JSON.stringify({ planType: 'WEEKLY', amount: 1, uid: 'attacker-uid' }),
  });
  const result = await response.json();
  const retryResponse = await fetch(`${baseUrl}/api/create-qr`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer valid-firebase-token',
      'idempotency-key': attemptId,
    },
    body: JSON.stringify({ planType: 'WEEKLY' }),
  });
  const retry = await retryResponse.json();
  const statusResponse = await fetch(`${baseUrl}/api/qr-status/${attemptId}`, {
    headers: { authorization: 'Bearer valid-firebase-token' },
  });
  const status = await statusResponse.json();

  assert.equal(response.status, 200);
  assert.equal(result.amount, 14900);
  assert.equal(result.status, 'pending');
  assert.equal(retryResponse.status, 200);
  assert.equal(retry.qrCodeId, result.qrCodeId);
  assert.equal(qrCreateCalls, 1);
  assert.equal(statusResponse.status, 200);
  assert.equal(status.status, 'pending');
  assert.equal(createdQr.payment_amount, 14900);
  assert.equal(createdQr.notes.uid, 'user-123');
  assert.equal(createdQr.notes.purchaseAttemptId, attemptId);
  assert.equal(createdQr.usage, 'single_use');
  assert.equal(db.documents.get(`qrPurchaseAttempts/${attemptId}`).state, 'pending');
});

test('QR webhook verifies raw-body signature and grants entitlement exactly once', async (t) => {
  const db = createMemoryFirestore();
  const qrCreatedAt = Math.floor(Date.now() / 1000);
  const qrCloseBy = qrCreatedAt + 60;
  const attemptId = '4c027c3b-61d5-4e31-b488-5500045b5c82';
  db.documents.set(`qrPurchaseAttempts/${attemptId}`, {
    uid: 'user-123',
    planType: 'WEEKLY',
    amount: 14900,
    state: 'pending',
    qrCodeId: 'qr_TestQr123',
    expiresAt: qrCloseBy,
  });

  const { baseUrl } = await startQrServer(t, {
    qrCode: {
      fetch: async () => ({
        id: 'qr_TestQr123',
        type: 'upi_qr',
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: 14900,
        created_at: qrCreatedAt,
        close_by: qrCloseBy,
        notes: {
          uid: 'user-123',
          planType: 'WEEKLY',
          purchaseAttemptId: attemptId,
        },
      }),
    },
    payments: {
      fetch: async () => ({
        id: paymentId,
        order_id: null,
        amount: 14900,
        currency: 'INR',
        method: 'upi',
        status: 'captured',
        captured: true,
        created_at: qrCreatedAt + 1,
      }),
    },
  }, db);
  const event = {
    event: 'qr_code.credited',
    payload: {
      qr_code: { entity: { id: 'qr_TestQr123' } },
      payment: { entity: { id: paymentId, status: 'captured' } },
    },
  };

  const first = await postRawWebhook(baseUrl, event);
  const duplicate = await postRawWebhook(baseUrl, event, 'evt_SecondDelivery123');

  assert.equal(first.response.status, 200);
  assert.equal(first.body.state, 'processed');
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.state, 'duplicate');
  assert.equal(db.documents.get(`qrPurchaseAttempts/${attemptId}`).state, 'paid');
  assert.equal(db.documents.get('users/user-123').isPremium, true);
  assert.equal(db.documents.get(`users/user-123/transactions/${paymentId}`).amount, 149);
  assert.equal(db.documents.get('users/user-123').activatedAt, (qrCreatedAt + 1) * 1000);
});

test('QR webhook rejects invalid signatures and does not touch purchase state', async (t) => {
  const db = createMemoryFirestore();
  const { baseUrl } = await startQrServer(t, {}, db);
  const result = await postRawWebhook(baseUrl, { event: 'qr_code.credited' }, undefined, '0'.repeat(64));
  assert.equal(result.response.status, 400);
  assert.equal(db.documents.size, 0);
});
