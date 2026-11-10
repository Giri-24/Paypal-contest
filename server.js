import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  GEMINI_API_KEY,
  MONGODB_URI,
  PORT = 3000
} = process.env;

const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.AI_MODEL || 'gemini-2.0-flash';
const PP = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com'; // sandbox default
const CUR = 'USD';

/* ---------- Data Schemas ---------- */
const MS = new mongoose.Schema({
  title: String,
  criteria: String,
  amount: Number,
  status: { type: String, default: 'pending' }, // pending > funded > submitted > verified > released | refunded | disputed
  orderId: String,
  authId: String,
  captureId: String,
  payoutId: String,
  submission: String,
  aiReport: Object,
  dispute: Object,
  log: [String]
}, { _id: false });

const Deal = mongoose.model('Deal', new mongoose.Schema({
  title: String,
  summary: String,
  clientName: String,
  freelancerName: String,
  freelancerEmail: String,
  milestones: [MS]
}, { timestamps: true }));

/* ---------- PayPal API ---------- */
let tok = { v: null, exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new Error('PayPal credentials missing: please configure PAYPAL_CLIENT_ID and PAYPAL_SECRET');
  }
  const r = await fetch(PP + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json();
  if (!r.ok) throw new Error('PayPal auth failed - verify PAYPAL_CLIENT_ID and PAYPAL_SECRET');
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.v;
}

async function pp(method, url, body) {
  const r = await fetch(PP + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + await token(),
      'Content-Type': 'application/json',
      'PayPal-Request-Id': randomUUID()
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  const j = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(j.details?.[0]?.description || j.message || `PayPal error ${r.status}`);
  return j;
}

/* ---------- Google Gemini AI ---------- */
async function ai(system, user) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in your environment variables');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    systemInstruction: {
      parts: [
        { text: system + '\nImportant: Output ONLY a valid JSON object. No explanations, no markdown codeblocks, no backticks.' }
      ]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: user }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2
    }
  };

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const j = await r.json();
  if (!r.ok) {
    const errMsg = j.error?.message || `Gemini API error (${r.status}): ${JSON.stringify(j)}`;
    console.error('Gemini API Error:', errMsg);
    throw new Error(errMsg);
  }

  const rawText = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!rawText) throw new Error('Gemini returned an empty response. Please retry.');

  // Clean markdown codeblocks if present
  const cleanJson = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(cleanJson);
  } catch (err) {
    console.error('Failed to parse Gemini JSON output:', rawText);
    throw new Error('Could not parse Gemini response as JSON: ' + err.message);
  }
}

/* ---------- App & Middleware ---------- */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(dir, 'public')));

const h = fn => (req, res) => fn(req, res).catch(e => {
  console.error(`Route error [${req.method} ${req.originalUrl}]:`, e.message);
  res.status(400).json({ error: e.message });
});

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

const need = (m, list) => {
  if (!list.includes(m.status)) throw new Error(`Action not allowed while milestone status is "${m.status}"`);
};

/* ---------- Routes ---------- */

// Healthcheck endpoint for Render / monitoring (supports both /health and /healthz)
app.get(['/health', '/healthz'], (_req, res) => {
  res.json({
    status: 'ok',
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    paypalConfigured: Boolean(PAYPAL_CLIENT_ID && PAYPAL_SECRET),
    dbConnected: mongoose.connection.readyState === 1
  });
});

app.get('/api/config', (_q, res) => {
  res.json({
    clientId: PAYPAL_CLIENT_ID,
    geminiModel: GEMINI_MODEL
  });
});

// 1. AI Draft agreement milestones
app.post('/api/draft', h(async (req, res) => {
  if (!req.body.text?.trim()) throw new Error('Please describe the agreement first');
  const result = await ai(
    'You are an expert escrow contract drafter. Convert the plain-language agreement into JSON with this structure: {"title":string,"summary":string,"milestones":[{"title":string,"criteria":string,"amount":number}]}. Create 2-5 progressive milestones. "criteria" must be clear, measurable, objective acceptance criteria. "amount" must be positive numbers in USD and must sum to the stated budget if provided.',
    req.body.text
  );
  res.json(result);
}));

// Deals CRUD
app.post('/api/deals', h(async (req, res) => {
  const b = req.body;
  if (!b.title || !b.clientName || !b.freelancerName || !b.freelancerEmail) {
    throw new Error('All participant names and the freelancer PayPal email are required');
  }
  const milestones = (b.milestones || [])
    .map(m => ({
      title: m.title,
      criteria: m.criteria,
      amount: Math.round((+m.amount || 0) * 100) / 100
    }))
    .filter(m => m.amount > 0);

  if (!milestones.length) throw new Error('At least one milestone with a valid amount is required');
  const deal = await Deal.create({ ...b, milestones });
  res.json(deal);
}));

app.get('/api/deals', h(async (_q, res) => {
  res.json(await Deal.find().sort('-createdAt').limit(50));
}));

app.get('/api/deals/:id', h(async (req, res) => {
  const deal = await Deal.findById(req.params.id);
  if (!deal) throw new Error('Deal not found');
  res.json(deal);
}));

const M = '/api/deals/:id/milestones/:i';

// 2. Client funds milestone: PayPal order with intent AUTHORIZE (hold funds)
app.post(M + '/order', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['pending']);
  const o = await pp('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{
      reference_id: `${d.id}-${req.params.i}`,
      description: `${d.title}: ${m.title}`.slice(0, 120),
      amount: { currency_code: CUR, value: m.amount.toFixed(2) }
    }]
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
  res.json(await save(d, m, `Funds held in escrow authorization (${au.id})`));
}));

// 3. Freelancer submits work delivery
app.post(M + '/submit', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['funded', 'submitted']);
  if (!req.body.submission?.trim()) throw new Error('Submission details cannot be empty');
  m.submission = req.body.submission.trim();
  m.status = 'submitted';
  res.json(await save(d, m, 'Deliverable work submitted'));
}));

// 4. Gemini AI Verifier checks the submission (fetches URL evidence if provided)
app.post(M + '/verify', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['submitted', 'verified']);
  
  let evidence = '';
  const url = (m.submission.match(/https?:\/\/\S+/) || [])[0];
  if (url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const rawHtml = await r.text();
      evidence = rawHtml
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 6000);
      evidence = `HTTP ${r.status}. Live page content: ${evidence}`;
    } catch {
      evidence = '(The submitted URL could not be fetched by the automated verifier)';
    }
  }

  const rep = await ai(
    'You are an impartial, meticulous code and deliverable verifier for an escrow payment service. Rigorously evaluate the submission against EVERY acceptance criterion using only verifiable evidence. Return JSON: {"verdict":"pass"|"partial"|"fail","score":number 0-100,"criteria":[{"criterion":string,"met":boolean,"evidence":string}],"summary":string,"suggested_release_percent":number 0-100}.',
    `ACCEPTANCE CRITERIA:\n${m.criteria}\n\nSUBMISSION DETAILS:\n${m.submission}\n\nFETCHED LIVE EVIDENCE:\n${evidence || 'No live link provided'}`
  );

  m.aiReport = rep;
  m.status = rep.verdict === 'pass' ? 'verified' : 'submitted';
  res.json(await save(d, m, `Gemini AI verification: ${rep.verdict.toUpperCase()} (Score: ${rep.score}/100)`));
}));

// 5. Dispute handling: Gemini AI Mediator recommends fair split
app.post(M + '/dispute', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['submitted', 'verified']);
  if (!req.body.reason?.trim()) throw new Error('Please state the dispute reason');

  const rul = await ai(
    'You are a neutral, objective escrow mediator. Analyze the acceptance criteria, freelancer submission, AI verification report, and the dispute claim. Recommend a fair financial split in JSON: {"recommended_release_percent":number 0-100 (percentage of funds to pay freelancer),"reasoning":string,"message_to_client":string,"message_to_freelancer":string}.',
    `ACCEPTANCE CRITERIA:\n${m.criteria}\n\nSUBMISSION:\n${m.submission}\n\nAI VERIFICATION REPORT:\n${JSON.stringify(m.aiReport || 'none')}\n\nDISPUTE RAISED BY: ${req.body.party}\nREASON: ${req.body.reason}`
  );

  m.dispute = { by: req.body.party, reason: req.body.reason, ...rul };
  m.status = 'disputed';
  res.json(await save(d, m, `Dispute opened by ${req.body.party}; Gemini recommends ${rul.recommended_release_percent}% release to freelancer`));
}));

// 6. Settle: capture (100% / partial) or void (0% refund to client) + PayPal Payout
app.post(M + '/settle', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['funded', 'submitted', 'verified', 'disputed']);
  const pct = Math.max(0, Math.min(100, +req.body.percent));
  if (Number.isNaN(pct)) throw new Error('Invalid percentage specified');

  if (pct === 0) {
    await pp('POST', `/v2/payments/authorizations/${m.authId}/void`);
    m.status = 'refunded';
    return res.json(await save(d, m, 'Authorization voided: 100% refunded to client'));
  }

  const amt = Math.round(m.amount * pct) / 100;
  const body = pct === 100
    ? { final_capture: true }
    : { amount: { currency_code: CUR, value: amt.toFixed(2) }, final_capture: true };

  const cap = await pp('POST', `/v2/payments/authorizations/${m.authId}/capture`, body);
  m.captureId = cap.id;
  m.status = 'released';
  await save(d, m, `Captured $${amt.toFixed(2)} (${pct}%)${pct < 100 ? '; remainder automatically returned to client' : ''}`);

  // Forward release to freelancer's PayPal email (requires Payouts on PayPal sandbox app)
  try {
    const p = await pp('POST', '/v1/payments/payouts', {
      sender_batch_header: {
        sender_batch_id: 'esc_' + Date.now(),
        email_subject: `Escrow Payment Released: ${d.title}`
      },
      items: [{
        recipient_type: 'EMAIL',
        receiver: d.freelancerEmail,
        amount: { value: amt.toFixed(2), currency: CUR },
        note: `Release for milestone: ${m.title}`
      }]
    });
    m.payoutId = p.batch_header.payout_batch_id;
    await save(d, m, `PayPal Payout sent to ${d.freelancerEmail}`);
  } catch (e) {
    await save(d, m, `Payout skipped: ${e.message}`);
  }

  res.json(d);
}));

/* ---------- Server Bootstrap ---------- */
async function startServer() {
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log('✅ Connected to MongoDB successfully');
    } catch (err) {
      console.error('❌ MongoDB connection error:', err.message);
    }
  } else {
    console.warn('⚠️ Warning: MONGODB_URI is not set. Database operations will fail.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️ Escrow Agent running at http://0.0.0.0:${PORT}`);
    console.log(`✨ AI Engine: Google Gemini API (${GEMINI_MODEL})`);
  });
}

startServer();
