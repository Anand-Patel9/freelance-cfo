import { loadConfig, validateConfig, isSandbox } from './config.js';
import { PayPalClient } from './paypal.js';
import { GeminiClient } from './gemini.js';
import { Store } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const { errors, warnings } = validateConfig(config);

for (const w of warnings) console.warn(`Warning: ${w}`);
if (errors.length) {
  console.error('\nCannot start. Please fix the following in your .env file:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nTip: run "npm run check" after fixing to test your PayPal and Gemini keys.\n');
  process.exit(1);
}

const paypal = new PayPalClient({
  clientId: config.paypal.clientId,
  clientSecret: config.paypal.clientSecret,
  baseUrl: config.paypal.baseUrl,
});
const ai = new GeminiClient(config.gemini);
const store = new Store({ dataDir: config.dataDir });
const app = createApp({ config, paypal, ai, store });

const server = app.listen(config.port, () => {
  console.log(`Freelance CFO is running at http://localhost:${config.port}`);
  console.log(`PayPal mode: ${isSandbox(config) ? 'SANDBOX (test money only)' : 'LIVE'}   |   AI model: ${config.gemini.model}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);