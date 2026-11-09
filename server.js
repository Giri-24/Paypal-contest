import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, ANTHROPIC_API_KEY, MONGODB_URI, AI_MODEL = 'claude-sonnet-5-5', PORT = 3000 } = process.env;
const PP = 'https://api-m.sandbox.paypal.com'; // sandbox only
const CUR = 'USD';

/* ---------- data ---------- */
const MS = new mongoose.Schema({
  title: String, criteria: String, amount: Number,
  status: { type: String, default: 'pending' }, // pending > funded > submitted > verified > released | refunded | disputed
  orderId: String, authId: String, captureId: String, payoutId: String,
  submission: String, aiReport: Object, dispute: Object, log: [String]
}, { _id: false });
const Deal = mongoose.model('Deal', new mongoose.Schema({
  title: String, summary: String, clientName: String, freelancerName: String, freelancerEmail: String, milestones: [MS]
}, { timestamps: true }));

/* ---------- PayPal ---------- */
let tok = { v: null, exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const r = await fetch(PP + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json();
  if (!r.ok) throw new Error('PayPal auth failed - check PAYPAL_CLIENT_ID / PAYPAL_SECRET');
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.v;
}
async function pp(method, url, body) {
  const r = await fetch(PP + url, {
    method,
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', 'PayPal-Request-Id': randomUUID() },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  const j = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(j.details?.[0]?.description || j.message || `PayPal error ${r.status}`);
  return j;
}

/* ---------- AI ---------- */
async function ai(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: 1800,
      system: system + '\nRespond with ONLY one valid JSON object. No prose, no code fences.',
      messages: [{ role: 'user', content: user }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'AI request failed');
  const text = j.content.filter(c => c.type === 'text').map(c => c.text).join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

/* ---------- helpers ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(dir, 'public')));
const h = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message }));
const stamp = () => new Date().toISOString().slice(11, 19) + ' ';
async function load(req) {
  const d = await Deal.findById(req.params.id);
  const m = d?.milestones[req.params.i];
  if (!m) throw new Error('Deal or milestone not found');
  return [d, m];
}
async function save(d, m, msg) {
  if (msg) m.log.push(stamp() + msg);
  d.markModified('milestones');
  await d.save();
  return d;
}
const need = (m, list) => { if (!list.includes(m.status)) throw new Error(`Not allowed while milestone is "${m.status}"`); };

/* ---------- routes ---------- */
app.get('/api/config', (_q, res) => res.json({ clientId: PAYPAL_CLIENT_ID }));

app.post('/api/draft', h(async (req, res) => {
  if (!req.body.text?.trim()) throw new Error('Describe the agreement first');
  res.json(await ai(
    'You are an escrow contract drafter. Convert the plain-language agreement into JSON: {"title":string,"summary":string,"milestones":[{"title":string,"criteria":string,"amount":number}]}. Use 2-5 milestones. "criteria" must be objective, checkable acceptance criteria. Amounts are USD, positive, and must sum to the total the user stated if they gave one.',
    req.body.text));
}));

app.post('/api/deals', h(async (req, res) => {
  const b = req.body;
  if (!b.title || !b.clientName || !b.freelancerName || !b.freelancerEmail) throw new Error('Fill in all names and the freelancer PayPal email');
  const milestones = (b.milestones || []).map(m => ({ title: m.title, criteria: m.criteria, amount: Math.round((+m.amount || 0) * 100) / 100 })).filter(m => m.amount > 0);
  if (!milestones.length) throw new Error('At least one milestone with an amount is required');
  res.json(await Deal.create({ ...b, milestones }));
}));

app.get('/api/deals', h(async (_q, res) => res.json(await Deal.find().sort('-createdAt').limit(50))));
app.get('/api/deals/:id', h(async (req, res) => res.json(await Deal.findById(req.params.id))));

const M = '/api/deals/:id/milestones/:i';

// 1) client funds the milestone: PayPal order with intent AUTHORIZE (money is held, not yet captured)
app.post(M + '/order', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['pending']);
  const o = await pp('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{ reference_id: `${d.id}-${req.params.i}`, description: `${d.title}: ${m.title}`.slice(0, 120), amount: { currency_code: CUR, value: m.amount.toFixed(2) } }]
  });
  m.orderId = o.id;
  await save(d, m);
  res.json({ id: o.id });
}));

app.post(M + '/authorize', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['pending']);
  const a = await pp('POST', `/v2/checkout/orders/${m.orderId}/authorize`);
  const au = a.purchase_units[0].payments.authorizations[0];
  m.authId = au.id;
  m.status = 'funded';
  res.json(await save(d, m, `Funds held in escrow (authorization ${au.id})`));
}));

// 2) freelancer submits work
app.post(M + '/submit', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['funded', 'submitted']);
  if (!req.body.submission?.trim()) throw new Error('Submission cannot be empty');
  m.submission = req.body.submission.trim();
  m.status = 'submitted';
  res.json(await save(d, m, 'Work submitted'));
}));

// 3) AI verifier checks the submission (and fetches any linked page as evidence)
app.post(M + '/verify', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['submitted', 'verified']);
  let evidence = '';
  const url = (m.submission.match(/https?:\/\/\S+/) || [])[0];
  if (url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      evidence = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
      evidence = `HTTP ${r.status}. Page text: ${evidence}`;
    } catch { evidence = '(the linked URL could not be fetched)'; }
  }
  const rep = await ai(
    'You are an impartial deliverable verifier for an escrow service. Judge the submission against EVERY acceptance criterion using only the evidence given; never invent evidence. Return {"verdict":"pass"|"partial"|"fail","score":number 0-100,"criteria":[{"criterion":string,"met":boolean,"evidence":string}],"summary":string,"suggested_release_percent":number 0-100}.',
    `ACCEPTANCE CRITERIA:\n${m.criteria}\n\nSUBMISSION:\n${m.submission}\n\nFETCHED LINK EVIDENCE:\n${evidence || 'n/a'}`);
  m.aiReport = rep;
  m.status = rep.verdict === 'pass' ? 'verified' : 'submitted';
  res.json(await save(d, m, `AI verification: ${rep.verdict} (${rep.score}/100)`));
}));

// 4) either party can dispute; AI mediator recommends a split
app.post(M + '/dispute', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['submitted', 'verified']);
  const rul = await ai(
    'You are a fair, neutral escrow mediator. Weigh the acceptance criteria, the submission, the AI verification report and the dispute reason. Return {"recommended_release_percent":number 0-100 (share of funds to pay the freelancer),"reasoning":string,"message_to_client":string,"message_to_freelancer":string}.',
    `CRITERIA:\n${m.criteria}\n\nSUBMISSION:\n${m.submission}\n\nAI VERIFICATION:\n${JSON.stringify(m.aiReport || 'none')}\n\nDISPUTE RAISED BY ${req.body.party}:\n${req.body.reason}`);
  m.dispute = { by: req.body.party, reason: req.body.reason, ...rul };
  m.status = 'disputed';
  res.json(await save(d, m, `Dispute opened; AI recommends ${rul.recommended_release_percent}% to freelancer`));
}));

// 5) settle: capture 100% / partial (rest released back to buyer) / void 0%
app.post(M + '/settle', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['funded', 'submitted', 'verified', 'disputed']);
  const pct = Math.max(0, Math.min(100, +req.body.percent));
  if (Number.isNaN(pct)) throw new Error('Invalid percent');
  if (pct === 0) {
    await pp('POST', `/v2/payments/authorizations/${m.authId}/void`);
    m.status = 'refunded';
    return res.json(await save(d, m, 'Authorization voided - client keeps 100%'));
  }
  const amt = Math.round(m.amount * pct) / 100;
  const body = pct === 100 ? { final_capture: true } : { amount: { currency_code: CUR, value: amt.toFixed(2) }, final_capture: true };
  const cap = await pp('POST', `/v2/payments/authorizations/${m.authId}/capture`, body);
  m.captureId = cap.id;
  m.status = 'released';
  await save(d, m, `Captured $${amt.toFixed(2)} (${pct}%)${pct < 100 ? '; remainder released back to client' : ''}`);
  try { // forward to the freelancer (needs Payouts enabled on the sandbox app)
    const p = await pp('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: 'esc' + Date.now(), email_subject: `Escrow released: ${d.title}` },
      items: [{ recipient_type: 'EMAIL', receiver: d.freelancerEmail, amount: { value: amt.toFixed(2), currency: CUR }, note: m.title }]
    });
    m.payoutId = p.batch_header.payout_batch_id;
    await save(d, m, `Payout sent to ${d.freelancerEmail}`);
  } catch (e) { await save(d, m, `Payout not sent: ${e.message}`); }
  res.json(d);
}));

await mongoose.connect(MONGODB_URI);
app.listen(PORT, () => console.log('Escrow Agent running on :' + PORT));
