'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  getFirebaseServices,
  getRazorpayInstance,
} = require('./services');
const { registerWebhookRoute } = require('./routes/webhook');
const { registerQrRoutes } = require('./routes/qr');
const { registerPaymentRoutes } = require('./routes/payments');

function createApp({
  razorpayFactory = getRazorpayInstance,
  firebaseServicesFactory = getFirebaseServices,
} = {}) {
  const app = express();
  const allowedOrigins = new Set(
    (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
  const dependencies = { razorpayFactory, firebaseServicesFactory };

  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS.'));
    },
  }));

  registerWebhookRoute(app, dependencies);

  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));

  app.get(['/', '/api/test'], (req, res) => res.status(200).json({
    success: true,
    message: 'Razorpay backend serverless function is live!',
    timestamp: new Date().toISOString(),
    envConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
  }));

  registerQrRoutes(app, dependencies);
  registerPaymentRoutes(app, dependencies);

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
