# ARS Solartech — Order to Dispatch Management System

Full-stack order tracking for ARS Solartech: orders, department stage approvals,
working-day forecasts, capacity loading, dispatch log, per-user roles and an
audit trail. Runs on Cloudflare Workers with a D1 database and email + password
accounts — no server to maintain.

```
public/            static SPA (index.html, styles.css, app.js)  – no build step
src/worker.ts      Hono Worker: auth wrap + role-enforced JSON API
src/db.ts          data access + capability checks
src/plan.ts        planning engine (working days, status, capacity)
src/schema.ts      idempotent D1 bootstrap (runs on first request)
schema.sql         D1 schema (same tables, for manual/local runs)
build.mjs          esbuild bundle + Sites deploy manifest
```

## Deployment

The Worker and its D1 database live in your own Cloudflare account. Connection
details stay in `wrangler.jsonc` and are never hard-coded in the application.
Each environment keeps its own D1 database, and the tables are created by the
Worker on its first request (`src/schema.ts`), so a fresh database needs no
manual step.

## Accounts and sign-in

Sign-in is email + password, handled entirely by this Worker — no third-party
identity provider, so it runs in any Cloudflare account.

* Passwords: PBKDF2-SHA256, 100k iterations, per-user random salt.
* Sessions: random 256-bit token, stored SHA-256 hashed in `sessions`, sent as
  an `HttpOnly; SameSite=Lax` cookie (Secure on HTTPS), 30-day expiry.
* **First visit** on an empty database shows *Create owner account*; that account
  becomes the owner. Every later account is created from **Users & roles → Add
  user** with a temporary password, which the person can change from **Your
  access** after signing in.
* Every state-changing request must come from the site's own origin; everything
  under `/api/*` is `private, no-store`.

## What the planner does

1. Design & BOM — *N* working days after the ERP confirmation date.
2. Drawing approval and material procurement run **in parallel** from the design date.
3. Production starts the next working day after the later of the two.
4. Production lasts `ROUNDUP(MT ÷ daily capacity)` working days, or an order override.
5. QC inspection, then packing & dispatch, each add their own working days.
6. Forecast dispatch is compared with the customer due date → RED / AMBER / GREEN.
7. Capacity is *working-day* overlap × MT per day per week, so weekends and
   holidays are never counted as capacity.

## Roles

| Role | Can do |
| --- | --- |
| Owner / Admin | everything, including settings and creating users |
| Editor | only the stages of their department (design, purchase, production, QC, dispatch, orders) |
| Viewer | read only |

Every check happens in the Worker. The UI only greys out what the server would
refuse anyway. The first account created becomes the owner; every other account
starts with the role and department the owner picks on **Users & roles**.

## Local development

```bash
npm install
npm run db:local     # create the local D1 tables
npm run dev          # http://localhost:8787
```

`wrangler.dev.jsonc` runs the same code against a local D1 database; the first
visit on `http://localhost:8787` asks you to create the owner account.

## Deploy to your own Cloudflare account

```bash
npx wrangler login                      # once per machine
npx wrangler d1 create <your-database-name>   # prints database_id
# put that id in wrangler.jsonc under d1_databases[0].database_id
npm run deploy                                # build + wrangler deploy
```

The Worker URL is printed at the end (`https://<worker>.<subdomain>.workers.dev`).
The D1 tables are created on the first request — nothing to run by hand.
`APP_ORIGIN` is optional: when it is not set, the Worker derives the origin from
the request (set it only if you serve the app from several hostnames).

Custom domain: Workers & Pages → your Worker → Settings → Domains & Routes →
Add custom domain.

## Importing orders

Excel workbook → *Save as CSV* → **Import** in the app. Recognised headers:

`Customer, Project, Structure Type, kWp, MT, PO Date, Confirmation Date, Due Date,
Priority, Sales Owner, Design days, Procurement days, Production days, Remarks`

Dates may be `YYYY-MM-DD` or `DD-MM-YYYY`. Imports only create new orders; they
never overwrite existing ones.
