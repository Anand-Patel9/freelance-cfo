// Holds two things:
//  1. proposals: actions the AI prepared that are waiting for a human decision (in memory, expire after 1 hour)
//  2. an audit log of everything that actually happened (kept in memory and appended to data/audit.jsonl)

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PROPOSAL_TTL_MS = 60 * 60 * 1000;
const MAX_AUDIT_IN_MEMORY = 500;

export class Store {
  constructor({ dataDir = 'data', now = () => Date.now(), persist = true } = {}) {
    this.now = now;
    this.proposals = new Map();
    this.auditLog = [];
    this.file = null;
    this.settingsFile = null;
    if (persist) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        this.file = path.join(dataDir, 'audit.jsonl');
        this.settingsFile = path.join(dataDir, 'settings.json');
        this.#load();
      } catch (err) {
        console.warn('[store] audit log file disabled:', err.message);
        this.file = null;
      }
    }
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-MAX_AUDIT_IN_MEMORY);
    for (const line of lines) {
      try {
        this.auditLog.push(JSON.parse(line));
      } catch {
        /* skip corrupt line */
      }
    }
  }

  #sweep() {
    const cutoff = this.now() - PROPOSAL_TTL_MS;
    for (const [id, p] of this.proposals) {
      if (p.createdAt < cutoff && p.status !== 'executing') this.proposals.delete(id);
    }
  }

  createProposal(data) {
    this.#sweep();
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const proposal = { id, status: 'pending', createdAt: this.now(), result: null, error: null, ...data };
    this.proposals.set(id, proposal);
    return proposal;
  }

  getProposal(id) {
    const p = this.proposals.get(id);
    if (!p) return null;
    if (p.createdAt < this.now() - PROPOSAL_TTL_MS && p.status !== 'executing') {
      this.proposals.delete(id);
      return null;
    }
    return p;
  }

  listProposals({ status = 'pending' } = {}) {
    this.#sweep();
    return [...this.proposals.values()]
      .filter((p) => status === 'all' || p.status === status)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Saved safety limits (data/settings.json). Returns {} if none were saved. */
  loadSettings() {
    if (!this.settingsFile) return {};
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveSettings(settings) {
    if (!this.settingsFile) return;
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2));
    } catch (err) {
      console.warn('[store] could not save settings:', err.message);
    }
  }

  updateProposal(id, patch) {
    const p = this.proposals.get(id);
    if (!p) return null;
    Object.assign(p, patch);
    return p;
  }

  audit(type, summary, extra = {}) {
    const entry = { ts: this.now(), type, summary, ...extra };
    this.auditLog.push(entry);
    if (this.auditLog.length > MAX_AUDIT_IN_MEMORY) this.auditLog.shift();
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
      } catch {
        /* never let logging break a request */
      }
    }
    return entry;
  }

  recentAudit(limit = 30) {
    return this.auditLog.slice(-limit).reverse();
  }

  /** Invoices sent recently, used to warn about probable duplicates. */
  recentSentInvoices() {
    return this.auditLog
      .filter((e) => e.type === 'invoice_sent' && e.email && typeof e.totalCents === 'number')
      .map((e) => ({ email: e.email, totalCents: e.totalCents, ts: e.ts }));
  }
}