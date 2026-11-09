# Escrow Agent: AI-verified escrow payments on PayPal

Plain-English agreement -> AI drafts milestones with checkable criteria -> client funds each milestone through PayPal (authorization hold, not a charge) -> freelancer submits work -> AI verifies it against the criteria (fetches the linked page as evidence) -> client releases (PayPal capture + payout) or either side disputes -> AI mediator recommends a split -> partial capture / void.

## Stack
Node 20 + Express, MongoDB (Mongoose), PayPal REST (Orders v2 AUTHORIZE, Authorizations capture/void, Payouts, JS SDK buttons), Claude API for drafting, verification and mediation. Plain HTML/JS frontend served by Express.

## Run locally
1. `cp .env.example .env` and fill in PayPal **sandbox** client id and secret, Anthropic key, MongoDB URI.
2. `npm install && npm start`, then open http://localhost:3000
3. Pay with a PayPal sandbox *personal* (buyer) account from developer.paypal.com > Testing Tools > Sandbox Accounts.
4. For payouts, enable "Payouts" under your sandbox app's features; otherwise settlement still captures and logs that the payout was skipped.

## Deploy on Render
New Web Service from this repo, build `npm install`, start `npm start`, add the env vars from `.env.example`.

## License
MIT
