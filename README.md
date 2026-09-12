# Marygold Collections — Full-stack E-commerce Portfolio Project

A portfolio-ready full-stack e-commerce demo: a customer storefront plus a server-side-protected admin dashboard, built with Node.js, Express and PostgreSQL.

## Features

### Storefront (customer-facing)
- Home, shop, product, cart, checkout, confirmation, about, contact, privacy, terms and 404/500 pages, plus dedicated `/category/<slug>` pages
- Curated homepage with featured products, bestsellers and category cards pulled live from the database
- Product search, category filters, price range and sorting
- Category navigation (desktop dropdown, mobile menu, footer) generated automatically from the database
- Shopping bag stored in `localStorage` with quantity controls
- Checkout with validation, stock checks, delivery-fee logic and automatic inventory decrement
- Order confirmation lookup protected by order email
- Newsletter and contact forms
- **Email notifications**: subscribers get a welcome email (and the store owner is notified of every new subscription with the running total), and every new order is emailed to the store owner with the full customer + item details (via SMTP; falls back to the server log when SMTP isn't configured)
- Nigerian Naira (₦/NGN) formatting and free-delivery over ₦100,000
- Fully responsive layout

### Admin (server-side protected)
- Secure login at `/admin/login` (`express-session` + `bcryptjs`), all `/api/admin/*` routes require a session
- Dashboard with revenue, orders, customers, low/out-of-stock counts and a 14-day sales chart
- Product CRUD (create, edit, delete, featured, rating, duplicate-name protection) with a category dropdown populated from the database and a quick "+ New" option to create a category inline
- **Image/video uploads**: upload a product image (JPG/PNG/GIF/WebP) or video (MP4/WebM/MOV) straight from the product form — files are stored under `public/uploads/` and the video plays on the product page
- **Category management**: add, edit and delete categories (auto-generated slugs, custom images and descriptions, duplicate-protection)
- Deleting a category with products is blocked; admins can reassign its products to another category in the same step
- Order management with status updates and full detail view
- Customer list with order counts and total spend
- Inventory table with low/out-of-stock badges
- Category performance analytics and top sellers
- Password change (hashed), session-based logout

## Tech
- Node.js 18+ / Express
- PostgreSQL 12+ via the `pg` driver
- `express-session` with a PostgreSQL session store (logins survive restarts)
- `bcryptjs` password hashing
- `nodemailer` for email notifications, `multer` for image/video uploads
- Vanilla JS front-end (no bundler), CSP security headers

## Run locally

**Quickest — `npm start` just works**

`npm start` boots a private PostgreSQL instance (owned by your user, no root/sudo needed) in `.data/pg` and then launches the app:

1. Install Node.js 18+ and the PostgreSQL server binaries (`postgresql`, or the server package for your distro — `initdb`/`pg_ctl` must be on `PATH` or under `/usr/lib/postgresql/*/bin`).
2. From the project folder run `npm install` (once).
3. Run `npm start`.
4. Open http://localhost:3000
5. Admin dashboard: http://localhost:3000/admin

The private database lives in `.data/pg` (git-ignored), listens on `127.0.0.1:5439` (the system PostgreSQL on `5432` is left alone) and is created + seeded automatically on first run. Localhost connections use trust auth, so no password is needed. Useful extras:

- `npm run db:start` / `npm run db:stop` / `npm run db:status` — manage just the database
- `npm run server` — run the app without touching the database (expects PostgreSQL to be reachable)

**Using your own PostgreSQL instead**

1. Create the database and a user:

   ```sql
   CREATE ROLE novacart LOGIN;
   CREATE DATABASE novacart OWNER novacart;
   ```

2. Put the same credentials in `.env` (see the variables table below), e.g. `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, or a single `DATABASE_URL`.
3. Run `npm install` and `npm start`.

The schema, and a seed catalog with sample products and categories, are created automatically on the first run.

## Public API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/config` | Store config (delivery fee, threshold, currency) |
| `GET /api/categories` | Categories with product counts (`?slug=` to fetch one) |
| `GET /api/categories/:id` | Single category |
| `GET /api/products` | Product list (`?q=&category=&category_id=&slug=&sort=&min=&max=&featured=&limit=`) |
| `GET /api/products/:id` | Single product |
| `GET /api/products/:id/related` | Related products |
| `GET /api/home` | Homepage data (featured, bestsellers, categories) |
| `GET /api/orders/:id?email=` | Order lookup by order number + email |

This project deliberately exposes **no** admin data publicly — every `/api/admin/*` route requires an authenticated session.

## Data model

`products` link to `categories` through a relational `category_id` foreign key. A denormalised `products.category` label is kept in sync whenever a category is renamed, so existing queries and filters keep working unmodified. Categories are seeded idempotently on startup (only when the table is empty), and slugs are auto-generated from category names (`Hats & Caps` → `hats-and-caps`). Deleting a category is blocked while it still contains products unless those products are moved to another category first.

### Admin credentials
- Email: the value of `ADMIN_EMAIL` in your environment
- Password: set via the `ADMIN_PASSWORD` environment variable (there is no default — the app refuses to start without one)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `ADMIN_EMAIL` | *(set your own)* | Admin login email (seeded on first run) |
| `ADMIN_PASSWORD` | *(required — no default)* | Admin login password (seeded on first run) |
| `SESSION_SECRET` | *(required — no default)* | Signs the admin session cookie — set a strong value (`openssl rand -hex 32`) |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/novacart` | Full Postgres connection string (overrides the `PG*` variables; add `?sslmode=require` for TLS) |
| `PGHOST` | `localhost` | Postgres host |
| `PGPORT` | `5432` | Postgres port |
| `PGUSER` | `novacart` | Postgres user |
| `PGPASSWORD` | `` | Postgres password |
| `PGDATABASE` | `novacart` | Postgres database name |
| `PGSSL` | `` | `1`/`true`/`required` to connect over TLS |
| `STORE_EMAIL` | `ADMIN_EMAIL` | Where order-notification emails are sent |
| `SMTP_HOST` | `` | Outgoing mail server (empty = emails printed to server log) |
| `SMTP_PORT` | `587` | SMTP port (`465` if `SMTP_SECURE=true`) |
| `SMTP_SECURE` | `false` | Use TLS/SSL for SMTP |
| `SMTP_USER` | `` | SMTP username |
| `SMTP_PASS` | `` | SMTP app password |
| `MAIL_FROM` | `Marygold Collections <no-reply@marygoldcollections.com>` | "From" address for sent emails |

### Email setup
Subscribers receive a confirmation email when they join the newsletter (and the store owner is emailed about every new subscription), and the store owner (`STORE_EMAIL`, defaulting to `ADMIN_EMAIL`) receives an email with the full customer and item breakdown for every new order. To actually deliver mail, set `SMTP_HOST` (plus `SMTP_USER`/`SMTP_PASS` — e.g. a Gmail app password). With no `SMTP_HOST`, the emails are written to the server log so local development still shows exactly what would be sent.

### Product image / video uploads
The admin product form uploads images and videos via `POST /api/admin/upload` (admin session required). Files land in `public/uploads/{images,videos}` and are served from `/uploads/...`. On Render (or any ephemeral host) uploads live for the life of the instance — for persistent production storage connect a CDN/object store instead.

## Deploying on Render

1. Push this repository to GitHub.
2. In Render, create a **New → Web Service**, select the repository.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add a database. Render offers a managed **PostgreSQL** add-on — create one and paste its internal connection string into `DATABASE_URL`.
6. Add environment variables: `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`.

Thanks to the PostgreSQL session store, any existing admin sessions remain valid after redeploys as long as the database is unchanged.

The trust proxy setting is enabled and the session cookie is sent as `Secure` only in production (`NODE_ENV=production`, set automatically by Render) over HTTPS.

## Important production note
Checkout in this build creates a real order and updates inventory, but it is intentionally a demo checkout. For a production store, integrate a payment provider (e.g. Paystack/Flutterwave), email notifications, rate limiting, and a managed database.