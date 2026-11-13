// "npm run check": verifies your .env before you start the app.
// Tests (1) PayPal sandbox login, (2) the Invoicing API, (3) your Gemini key and model.

import { loadConfig, validateConfig } from './config.js';
import { PayPalClient } from './paypal.js';
import { GeminiClient } from './gemini.js';

const config = loadConfig();
const { errors, warnings } = validateConfig(config);
for (const w of warnings) console.warn(`Warning: ${w}`);
if (errors.length) {
  console.error('\nConfiguration problems:');
  for (const e of errors) console.error(`  x ${e}`);
  process.exit(1);
}

let failed = false;
const ok = (msg) => console.log(`  OK  ${msg}`);
const bad = (msg) => {
  failed = true;
  console.error(`  FAIL  ${msg}`);
};

console.log('\n1) PayPal sandbox login');
const paypal = new PayPalClient({
  clientId: config.paypal.clientId,
  clientSecret: config.paypal.clientSecret,
  baseUrl: config.paypal.baseUrl,
});
try {
  await paypal.getToken();
  ok(`Authenticated against ${config.paypal.baseUrl}`);
  if (/\/services\/invoicing/.test(paypal.scope)) {
    ok('This app\'s token includes the Invoicing permission');
  } else {
    bad('This app\'s token does NOT include the Invoicing permission. The Client ID in .env belongs to an app where Invoicing is not enabled (or the change was not saved).');
  }
} catch (err) {
  bad(err.message);
}

console.log('\n2) PayPal Invoicing API');
if (!failed) {
  try {
    const invoices = await paypal.listInvoices({ pageSize: 10, maxPages: 1 });
    ok(`Invoicing works. Invoices visible in this sandbox account: ${invoices.length}`);
  } catch (err) {
    bad(`${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ''}`);
    console.error('        Hint: open your sandbox app in the PayPal Developer Dashboard and make sure Invoicing is enabled.');
  }
}

console.log('\n3) Gemini AI');
const started = Date.now();
try {
  // Fail fast here: one retry and a 25 second limit, so a bad connection does not hang the check.
  const ai = new GeminiClient({ ...config.gemini, maxRetries: 1, timeoutMs: 25_000 });
  const res = await ai.generate({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }] });
  ok(`Model "${res.model}" answered in ${((Date.now() - started) / 1000).toFixed(1)}s: ${res.text.slice(0, 40) || '(empty)'}`);
} catch (err) {
  bad(`${err.message} (after ${((Date.now() - started) / 1000).toFixed(0)}s)`);
  console.error('        Hint: Gemini is slow or unreachable from here. Try again, or set GEMINI_MODEL in .env to a faster model (see README).');
}

console.log(failed ? '\nSome checks failed. Fix the items above, then run "npm run check" again.\n' : '\nAll good. Start the app with: npm start\n');
process.exit(failed ? 1 : 0);