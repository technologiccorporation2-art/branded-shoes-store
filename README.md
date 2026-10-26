# Branded Shoes.com — Bangladesh ecommerce starter

This is a full-stack starter project, not a hosted/live store yet. It includes a responsive storefront, SQLite database, product listing/search/filter, cart, checkout, COD and manual bKash/Nagad transaction reference collection, contact form, and an admin dashboard.

## Requirements
- Node.js 20 or newer
- npm

## Run locally
1. Extract the ZIP.
2. Copy `.env.example` to `.env`.
3. Generate a strong session secret and set a unique admin password (12+ characters).
   - Example secret generator: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
4. Update `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and the bKash/Nagad merchant numbers in `.env`.
5. Run `npm install`
6. Run `npm start`
7. Open `http://localhost:3000`

The app creates `data/store.db` and seeds example products automatically. The first admin is created from the `.env` username/password at startup if that username does not already exist. If you change the admin password in `.env` later, it does not automatically overwrite an existing admin record; use a proper password-reset procedure for a live deployment.

## Payment notes
- Cash on Delivery is supported in the order flow.
- bKash and Nagad currently collect the payer number and TrxID for manual verification in Admin. They do **not** automatically charge or verify payments.
- To accept automatic payments, obtain approved merchant credentials and integrate the official payment APIs using the current merchant documentation. Never put API secrets in frontend code or commit them to Git.
- Configure actual merchant payment numbers in `.env` and display verified business details/policies before launch.

## Important production checklist
Before accepting real customer data or orders:
- Use HTTPS and set `NODE_ENV=production`.
- Replace Express's default in-memory session store with a persistent production session store (the default store is not suitable for production).
- Back up the SQLite database and confirm persistent disk storage on the hosting provider; consider PostgreSQL for a managed multi-instance deployment.
- Configure real business contact details, shipping charges/regions, return/refund policy, privacy policy, and order notifications.
- Add transactional email/SMS/WhatsApp notifications if needed.
- Review security, privacy, tax, consumer-protection, and payment-provider requirements for your business.
- Test stock handling, payment reconciliation, cancellations/refunds, and backup restoration.
- Use only images you have permission to use and confirm product authenticity claims.
- Do not deploy with the example merchant number or a weak/default password.

## Current API overview
Public: `GET /api/config`, `GET /api/products`, `POST /api/orders`, `POST /api/contact`.
Admin: `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/orders`, `PATCH /api/admin/orders/:id`, `GET /api/admin/products`, `POST /api/admin/products`, `PATCH /api/admin/products/:id`, `GET /api/admin/messages`.

Admin mutations and public form submissions require the session CSRF token provided by `/api/config` or `/api/admin/session`.
