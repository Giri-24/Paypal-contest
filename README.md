# MINT — Mission Intelligence & Negotiation Technology
### AI-Verified Milestone Escrow on PayPal with Smart Advisor & Escrow Guard

MINT is an institutional commercial procurement and milestone escrow platform combining **PayPal REST v2 authorization holds** with **Google Gemini 2.0 Flash** for objective deliverable verification and neutral dispute mediation.

---

## Core System Architecture

```
[Plain-English Scope]
         │
         ▼
[Gemini Drafter] ──> [Objective Milestones with Measurable Criteria]
                           │
                           ▼
                 [Client Funds Milestone]
                 (PayPal AUTHORIZE Hold)
                           │
                           ▼
                [Freelancer Submits Work]
                           │
                           ▼
                 [Gemini AI Verifier]
              (Fetches Live URL & Inspects)
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
       [Criteria Met]              [Dispute Claim]
             │                           │
             ▼                           ▼
     [Client Release]            [Gemini Mediator]
   (Capture + Payout)          (Recommends Split %)
```

---

## Add-On: PayPal Smart Advisor & Escrow Guard

A full-stack intelligence add-on designed to improve PayPal service adoption, protect escrow holds, and provide transparent gateway recommendations:

### 1. Escrow Guard (Longevity Monitoring & Renewal)
- Tracks PayPal authorization hold periods:
  - **Guaranteed Hold** (&le; 72 hours / 3 days): Within the PayPal honor period where funds are guaranteed.
  - **Unguaranteed Hold** (3 to 28 days): Hold remains capturable for up to 29 days, but prompts renewal.
  - **Expiring / Expired** (&ge; 28 days): Prompts immediate renewal to prevent losing the authorization hold.
- **One-Click Programmatic Reauthorization:** Renews the 3-day guarantee via `POST /api/deals/:id/milestones/:i/reauthorize` directly from the dashboard or milestone card.

### 2. Transparent Gateway Comparison Matrix
- Objectively benchmarks PayPal against standard card gateways and commercial bank wires using an escrow-weighted scoring model:
  - **PayPal Escrow (Score: 96/100):** Only rail with native 29-day authorization hold, programmatic partial capture, zero-fee voids, and instant payout.
  - **Direct Card Gateway (Score: 72/100):** Strict 7-day hold window, no native partial capture.
  - **Bank Wire (Score: 45/100):** Irreversible push payment with no escrow hold.
- **Honest Trade-Off Analysis:** Transparently discloses fee differences (e.g. flat-fee wire savings on >$10k orders) while detailing why PayPal's native authorization holds and partial capture are strictly necessary for milestone security.

### 3. Contextual Product Recommendations
- Evaluates each milestone's scale, terms, and counterparty region to suggest:
  - **Checkout with AUTHORIZE:** Primary escrow mechanism (funds pre-authorized without immediate capture).
  - **Pay Later / Pay in 4:** Installment options for eligible milestones ($30–$1,500) for US buyers.
  - **Venmo Settlement:** Frictionless mobile approval for US clients and freelancers.
  - **Card-through-PayPal (ACDC / Guest):** Enables enterprise buyers without PayPal accounts to fund holds directly via cards.
  - **Invoicing API:** Suggested for large commercial milestones (&ge; $10,000) with formal itemized tax schedules.
  - **Subscriptions:** Automates retainer-based or recurring milestone maintenance.
  - **Payouts:** Automated disbursement to the supplier upon deliverable signoff.

### 4. Dashboard Integration
- Command Center card embedded directly on MINT's **Dashboard**:
  - Live count and dollar sum of active escrow holds.
  - Real-time breakdown of guaranteed, unguaranteed, and expiring holds with instant renewal triggers.
  - Gateway benchmarking scorecard and product highlights.

### 5. Deterministic Idempotency Hardening
- Replaced non-idempotent random UUID headers with deterministic `PayPal-Request-Id` headers:
  - Orders: `${dealId}-${index}-order`
  - Authorizations: `${dealId}-${index}-auth`
  - Captures: `${dealId}-${index}-capture`
  - Reauthorizations: `${dealId}-${index}-reauth`

---

## Local Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   Create `.env` based on `.env.example`:
   ```bash
   cp .env.example .env
   ```
   Fill in `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `GEMINI_API_KEY`, and optional `MONGODB_URI`.
   *(If `MONGODB_URI` is omitted, MINT automatically operates with its embedded in-memory repository seeded with sample agreements).*

3. **Start the application:**
   ```bash
   npm start
   ```
   Open **http://localhost:3000** in your browser.

---

## License
MIT
