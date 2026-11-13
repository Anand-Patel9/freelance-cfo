// "npm run seed -- --yes": fills your PayPal SANDBOX with realistic demo invoices
// (one paid, two overdue, one not yet due) so the dashboard, aging chart, reminders
// and collections review have something real to work with.
//
// This is a developer tool. It talks to the sandbox only and needs --yes to run.

import { randomUUID } from 'node:crypto';
import { loadConfig, validateConfig, isSandbox } from './config.js';
import { PayPalClient } from './paypal.js';
import { addDays, buildPayPalInvoice, normalizeInvoiceInput } from './invoices.js';

const args = new Set(process.argv.slice(2));
const config = loadConfig();
const { errors } = validateConfig(config);
if (errors.length) {
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (!isSandbox(config)) {
  console.error('Refusing to seed: this is not the PayPal sandbox.');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const DEMO = [
  { name: 'Ankit Verma', email: 'ankit@example.com', item: 'Logo design', qty: 1, price: 250, issued: -20, due: -6, paid: true },
  { name: 'Ravi Kumar', email: 'ravi@example.com', item: 'Website redesign (phase 1)', qty: 1, price: 300, issued: -45, due: -30 },
  { name: 'Mia Chen', email: 'mia@example.com', item: 'Social media banners', qty: 2, price: 60, issued: -17, due: -3 },
  { name: 'Priya Sharma', email: 'priya@example.com', item: 'Copywriting (per page)', qty: 3, price: 50, issued: 0, due: 10 },
];

console.log(`\nThis will create ${DEMO.length} demo invoices in your PayPal SANDBOX account (${config.paypal.baseUrl}).`);
if (!args.has('--yes')) {
  console.log('Nothing was changed. Run it again with:  npm run seed -- --yes\n');
  process.exit(0);
}

const paypal = new PayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, baseUrl: config.paypal.baseUrl });
let failures = 0;

for (const d of DEMO) {
  const label = `${d.name} (${d.item})`;
  try {
    const result = normalizeInvoiceInput(
      { clientName: d.name, clientEmail: d.email, lineItems: [{ description: d.item, quantity: d.qty, unitPrice: d.price }], dueDate: addDays(today, Math.max(d.due, 0)), note: 'Demo data created by npm run seed' },
      { today, limits: config.limits, requireEmail: true }
    );
    if (!result.ok) throw new Error(result.errors.join(' '));
    // The app itself never allows past dates; the seed tool sets them directly to create overdue examples.
    const value = { ...result.value, invoiceDate: addDays(today, d.issued), dueDate: addDays(today, d.due) };
    const created = await paypal.createDraftInvoice(buildPayPalInvoice(value, { invoicerEmail: config.paypal.invoicerEmail }), randomUUID());
    await paypal.sendInvoice(created.id);
    if (d.paid) {
      await paypal.recordPayment(created.id, { method: 'BANK_TRANSFER', date: addDays(today, -4), amount: (value.totalCents / 100).toFixed(2), currency: 'USD', note: 'Demo payment' });
    }
    console.log(`  OK    ${label}: ${created.id}${d.paid ? ' (marked paid)' : ''}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${label}: ${err.message}`);
  }
}

console.log(failures ? `\nDone with ${failures} problem(s). The ones that worked are in your sandbox account.\n` : '\nDone. Open the app and refresh the dashboard.\n');
process.exit(failures ? 1 : 0);