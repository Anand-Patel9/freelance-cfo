// Central configuration. Everything comes from environment variables (.env locally,
// the dashboard on Render). Nothing secret is ever hard-coded or sent to the browser.

const toNumber = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: toNumber(env.PORT, 3000),
    dataDir: env.DATA_DIR || 'data',
    allowLive: String(env.ALLOW_LIVE || '').toLowerCase() === 'true',
    // Optional access password for hosted deployments. Leave empty for local use.
    appPassword: env.APP_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    paypal: {
      clientId: (env.PAYPAL_CLIENT_ID || '').trim(),
      clientSecret: (env.PAYPAL_CLIENT_SECRET || '').trim(),
      baseUrl: (env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').trim().replace(/\/+$/, ''),
      // Optional: only needed if PayPal asks for an invoicer email on your sandbox business account.
      invoicerEmail: (env.PAYPAL_INVOICER_EMAIL || '').trim(),
    },
    gemini: {
      apiKey: (env.GEMINI_API_KEY || '').trim(),
      // Comma separated: first is preferred, the rest are automatic fallbacks (see README).
      model: (env.GEMINI_MODEL || 'gemini-3-flash-preview,gemini-3.5-flash,gemini-3.1-flash-lite-preview,gemini-flash-lite-latest').trim(),
      baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').trim().replace(/\/+$/, ''),
    },
    limits: {
      // Hard stop: the server refuses to create invoices above this amount.
      maxInvoiceAmount: toNumber(env.MAX_INVOICE_AMOUNT, 5000),
      // At or above this amount the user must tick an extra confirmation box.
      highValueThreshold: toNumber(env.HIGH_VALUE_THRESHOLD, 1000),
      defaultDueDays: toNumber(env.DEFAULT_DUE_DAYS, 14),
      chatPerMinute: toNumber(env.CHAT_RATE_PER_MIN, 12),
      actionPerMinute: toNumber(env.ACTION_RATE_PER_MIN, 30),
    },
  };
}

export function isSandbox(config) {
  return /sandbox/i.test(config.paypal.baseUrl);
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.paypal.clientId || !config.paypal.clientSecret) {
    errors.push('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see README, step 3).');
  }
  if (!config.gemini.apiKey) {
    errors.push('GEMINI_API_KEY must be set (see README, step 3).');
  }
  if (!isSandbox(config)) {
    if (config.allowLive) {
      warnings.push('PAYPAL_BASE_URL is NOT a sandbox URL and ALLOW_LIVE=true: this will use REAL PayPal accounts.');
    } else {
      errors.push(
        'PAYPAL_BASE_URL does not look like a sandbox URL. This project only talks to the PayPal sandbox ' +
          'unless you explicitly set ALLOW_LIVE=true. Use https://api-m.sandbox.paypal.com'
      );
    }
  }
  if (config.limits.highValueThreshold > config.limits.maxInvoiceAmount) {
    warnings.push('HIGH_VALUE_THRESHOLD is above MAX_INVOICE_AMOUNT, so the extra confirmation step will never trigger.');
  }
  return { errors, warnings };
}