# ARS Solartech — Order to Dispatch Management System

Full-stack order tracking for ARS Solartech: orders, department stage approvals,
working-day forecasts, capacity loading, dispatch log, per-user roles and an
audit trail. Runs on Cloudflare Workers with a D1 database and "Sign in with
Freebuff" accounts — no server to maintain, no passwords to store.

```
public/            static SPA (index.html, styles.css, app.js)  – no build step
src/worker.ts      Hono Worker: auth wrap + role-enforced JSON API
src/db.ts          data access + capability checks
src/plan.ts        planning engine (working days, status, capacity)
src/schema.ts      idempotent D1 bootstrap (runs on first request)
schema.sql         D1 schema (same tables, for manual/local runs)
build.mjs          esbuild bundle + Sites deploy manifest
```

## Live URLs

| Environment | URL |
| --- | --- |
| Production | https://ars-order-to-dispatch-3qnck5.freebuff.site |
| Preview | https://ars-order-to-dispatch-3qnck5-preview.freebuff.site |

Both environments have their own D1 database. Tables are created by the Worker
on its first request (`src/schema.ts`), so a fresh database needs no manual step.

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
| Owner / Admin | everything, including settings and user approval |
| Editor | only the stages of their department (design, purchase, production, QC, dispatch, orders) |
| Viewer | read only |

Every check happens in the Worker. The UI only greys out what the server would
refuse anyway. The first account to sign in becomes the owner; everyone else
lands as a viewer until the owner assigns a department and role on **Users & roles**.

## Local development

```bash
npm install
npm run db:local     # create the local D1 tables
npm run dev          # http://localhost:8787
```

`wrangler.dev.jsonc` carries the development Freebuff client ID and
`APP_ORIGIN=http://localhost:8787`. Sign-in opens Freebuff and returns to
`/auth/freebuff/callback`.

## Deploy (Cloudflare)

Freebuff Sites injects `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN`
and binds `DB`; `npm run build` writes `dist/manifest.json`, then deploy the
`dist` folder with the Sites deployer.

For a plain Cloudflare account instead:

```bash
npx wrangler d1 create ars-oms          # copy the database_id
npx wrangler d1 execute ars-oms --remote --file=schema.sql
# set DB, FREEBUFF_CLIENT_ID (production client for your exact origin),
# FREEBUFF_ISSUER and APP_ORIGIN in wrangler.jsonc, then:
npm run build && npx wrangler deploy
```

Register the production redirect URI `https://<your-domain>/auth/freebuff/callback`
before going live.

## Importing orders

Excel workbook → *Save as CSV* → **Import** in the app. Recognised headers:

`Customer, Project, Structure Type, kWp, MT, PO Date, Confirmation Date, Due Date,
Priority, Sales Owner, Design days, Procurement days, Production days, Remarks`

Dates may be `YYYY-MM-DD` or `DD-MM-YYYY`. Imports only create new orders; they
never overwrite existing ones.
