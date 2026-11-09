'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  getFirebaseServices,
  getMissingEnv,
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
      // Android app requests have no Origin header, so they are allowed.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      const error = new Error('Origin is not allowed by CORS.');
      error.code = 'CORS_ORIGIN_DENIED';
      return callback(error);
    },
  }));

  // Webhook must be registered BEFORE express.json() because it needs the raw body.
  registerWebhookRoute(app, dependencies);

  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));

  app.get(['/', '/api/test'], (req, res) => {
    const missing = getMissingEnv();
    const body = {
      success: true,
      message: 'Razorpay backend serverless function is live!',
      timestamp: new Date().toISOString(),
      envConfigured: missing.length === 0,
    };
    // Only show variable names outside production (names only, never values).
    if (process.env.VERCEL_ENV !== 'production') body.missingEnv = missing;
    return res.status(200).json(body);
  });

  registerQrRoutes(app, dependencies);
  registerPaymentRoutes(app, dependencies);

  // 404 handler (must come after all routes)
  app.use((req, res) => res.status(404).json({ success: false, error: 'Route not found.' }));

  // Central error handler
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('Unhandled error:', error.code || '', error.message);
    const status = error.type === 'entity.too.large'
      ? 413
      : error.type === 'entity.parse.failed'
        ? 400
        : error.code === 'CORS_ORIGIN_DENIED'
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