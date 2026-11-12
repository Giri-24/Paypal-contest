import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { registerAdvisor } from './paypal-advisor.js';

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
  authAt: Date, // Timestamp of PayPal authorization hold for Escrow Guard
  captureId: String,
  payoutId: String,
  submission: String,
  aiReport: Object,
  dispute: Object,
  log: [String]
}, { _id: false });

const DealModel = mongoose.model('Deal', new mongoose.Schema({
  title: String,
  summary: String,
  clientName: String,
  freelancerName: String,
  freelancerEmail: String,
  milestones: [MS]
}, { timestamps: true }));

/* ---------- Memory Fallback Store (Instant Local Run) ---------- */
let isMongoOnline = false;
const memoryDeals = new Map();

function initDemoDeals() {
  const demoId = 'deal_mwdjrzun';
  memoryDeals.set(demoId, {
    _id: demoId,
    id: demoId,
    title: 'Water Treatment Pump Station Upgrade',
    summary: 'Procurement, FAT certification, and site commissioning of 3x 150HP Centrifugal Pumps.',
    clientName: 'Sarah Chen (AquaFlow Industries)',
    freelancerName: 'AquaSource Global',
    freelancerEmail: 'sb-seller@example.com',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    milestones: [
      {
        title: 'Factory Acceptance Testing (FAT) & Quality Certificates',
        criteria: 'Factory test certificate signed by QA inspector, ISO 9906 hydraulic performance curve report, and material test certificates.',
        amount: 15000,
        status: 'funded',
        authId: 'AUTH-DEMO-87291',
        authAt: new Date(Date.now() - 36 * 3600 * 1000), // 36h ago (active inside 72h honor period)
        orderId: 'ORDER-DEMO-991',
        submission: 'FAT report verified at factory inspection: https://example.com/reports/fat-pump-test.pdf - Serial numbers: AQ-150-01 to 03 checked.',
        aiReport: null,
        dispute: null,
        log: [
          '10:30:00 PayPal authorization hold secured for $15,000.00 USD (Auth: AUTH-DEMO-87291)',
          '11:15:00 Deliverable submitted with QA report'
        ]
      },
      {
        title: 'Physical Delivery & On-Site Hydraulic Commissioning',
        criteria: 'Bill of lading proving CIF port delivery, physical undamaged receiving receipt signed by site manager, and 48-hour continuous run test data log.',
        amount: 33300,
        status: 'pending',
        authId: null,
        authAt: null,
        orderId: null,
        submission: null,
        aiReport: null,
        dispute: null,
        log: [
          '10:30:00 Milestone created; awaiting buyer authorization hold'
        ]
      }
    ],
    markModified: function() {},
    save: async function() { return this; }
  });
}
initDemoDeals();

// Deal repository dispatcher: seamless Mongo + memory fallback
const Deal = {
  async find() {
    if (isMongoOnline) {
      try {
        return await DealModel.find().sort('-createdAt').limit(50);
      } catch (err) {
        console.warn('Mongo find error, using memory store:', err.message);
      }
    }
    return Array.from(memoryDeals.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  async findById(id) {
    if (isMongoOnline) {
      try {
        const item = await DealModel.findById(id);
        if (item) return item;
      } catch (err) {
        console.warn('Mongo findById error, using memory store:', err.message);
      }
    }
    return memoryDeals.get(id) || null;
  },
  async create(data) {
    if (isMongoOnline) {
      try {
        return await DealModel.create(data);
      } catch (err) {
        console.warn('Mongo create error, using memory store:', err.message);
      }
    }
    const id = 'deal_' + randomUUID().slice(0, 8);
    const newDeal = {
      _id: id,
      id,
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      milestones: (data.milestones || []).map(m => ({
        ...m,
        status: m.status || 'pending',
        log: m.log || [stamp() + 'Milestone initialized']
      })),
      markModified: function() {},
      save: async function() { return this; }
    };
    memoryDeals.set(id, newDeal);
    return newDeal;
  }
};

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

// Hardened pp() with deterministic idempotency request IDs
async function pp(method, url, body, reqId) {
  const r = await fetch(PP + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + await token(),
      'Content-Type': 'application/json',
      'PayPal-Request-Id': reqId || randomUUID()
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
  const m = d?.milestones?.[req.params.i];
  if (!m) throw new Error('Deal or milestone not found');
  return [d, m];
}

async function save(d, m, msg) {
  if (msg) {
    m.log = m.log || [];
    m.log.push(stamp() + msg);
  }
  if (typeof d.markModified === 'function') d.markModified('milestones');
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
    storage: isMongoOnline ? 'mongodb' : 'embedded-memory',
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    paypalConfigured: Boolean(PAYPAL_CLIENT_ID && PAYPAL_SECRET),
    dbConnected: isMongoOnline
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
  res.json(await Deal.find());
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
  const reqId = `${d._id || d.id}-${req.params.i}-order`;
  const o = await pp('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{
      reference_id: `${d._id || d.id}-${req.params.i}`,
      description: `${d.title}: ${m.title}`.slice(0, 120),
      amount: { currency_code: CUR, value: m.amount.toFixed(2) }
    }]
  }, reqId);
  m.orderId = o.id;
  await save(d, m);
  res.json({ id: o.id });
}));

app.post(M + '/authorize', h(async (req, res) => {
  const [d, m] = await load(req);
  need(m, ['pending']);
  const reqId = `${d._id || d.id}-${req.params.i}-auth`;
  const a = await pp('POST', `/v2/checkout/orders/${m.orderId}/authorize`, null, reqId);
  const au = a.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!au) throw new Error('PayPal authorization record missing from order response');
  m.authId = au.id;
  m.authAt = new Date();
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
    if (m.authId && !m.authId.startsWith('AUTH-DEMO')) {
      await pp('POST', `/v2/payments/authorizations/${m.authId}/void`);
    }
    m.status = 'refunded';
    return res.json(await save(d, m, 'Authorization voided: 100% refunded to client'));
  }

  const amt = Math.round(m.amount * pct) / 100;
  const body = pct === 100
    ? { final_capture: true }
    : { amount: { currency_code: CUR, value: amt.toFixed(2) }, final_capture: true };

  const capReqId = `${d._id || d.id}-${req.params.i}-capture`;
  if (m.authId && !m.authId.startsWith('AUTH-DEMO')) {
    const cap = await pp('POST', `/v2/payments/authorizations/${m.authId}/capture`, body, capReqId);
    m.captureId = cap.id;
  } else {
    m.captureId = 'CAP-SIMULATED-' + randomUUID().slice(0, 8);
  }

  m.status = 'released';
  await save(d, m, `Captured $${amt.toFixed(2)} (${pct}%)${pct < 100 ? '; remainder automatically returned to client' : ''}`);

  // Forward release to freelancer's PayPal email (requires Payouts on PayPal sandbox app)
  if (d.freelancerEmail && PAYPAL_CLIENT_ID && PAYPAL_SECRET) {
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
      m.payoutId = p.batch_header?.payout_batch_id;
      await save(d, m, `PayPal Payout sent to ${d.freelancerEmail}`);
    } catch (e) {
      console.warn('Payout skipped:', e.message);
      await save(d, m, `Payout skipped: ${e.message}`);
    }
  }

  res.json(d);
}));

/* ---------- Register PayPal Smart Advisor & Escrow Guard ---------- */
registerAdvisor(app, { Deal, pp, h, load, save });

/* ---------- Server Bootstrap ---------- */
async function startServer() {
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
      isMongoOnline = true;
      console.log('✅ Connected to MongoDB successfully');
    } catch (err) {
      console.warn('⚠️ MongoDB connection failed. Operating with active embedded memory store:', err.message);
    }
  } else {
    console.log('ℹ️ Operating with embedded in-memory deal repository (configure MONGODB_URI for persistence)');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️ Escrow Agent & MINT OS active at http://localhost:${PORT}`);
    console.log(`✨ AI Engine: Google Gemini API (${GEMINI_MODEL})`);
  });
}

export { app, Deal };

startServer();
