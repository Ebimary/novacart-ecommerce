# NovaCart — Full-stack E-commerce Portfolio Project

A portfolio-ready full-stack e-commerce demo: a customer storefront plus a server-side-protected admin dashboard, built with Node.js, Express and SQLite.

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
- Nigerian Naira (₦/NGN) formatting and free-delivery over ₦100,000
- Fully responsive layout

### Admin (server-side protected)
- Secure login at `/admin/login` (`express-session` + `bcryptjs`), all `/api/admin/*` routes require a session
- Dashboard with revenue, orders, customers, low/out-of-stock counts and a 14-day sales chart
- Product CRUD (create, edit, delete, featured, rating, duplicate-name protection) with a category dropdown populated from the database and a quick "+ New" option to create a category inline
- **Category management**: add, edit and delete categories (auto-generated slugs, custom images and descriptions, duplicate-protection)
- Deleting a category with products is blocked; admins can reassign its products to another category in the same step
- Order management with status updates and full detail view
- Customer list with order counts and total spend
- Inventory table with low/out-of-stock badges
- Category performance analytics and top sellers
- Password change (hashed), session-based logout

## Tech
- Node.js 18+ / Express
- SQLite via `better-sqlite3`
- `express-session` with a custom SQLite session store
- `bcryptjs` password hashing
- Vanilla JS front-end (no bundler), CSP security headers

## Run locally
1. Install Node.js 18+.
2. From the project folder run `npm install`.
3. Run `npm start`.
4. Open http://localhost:3000
5. Admin dashboard: http://localhost:3000/admin

The SQLite database `novacart.db` is created — and seeded with sample products and categories — automatically on first run.

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

### Default admin credentials (local demo only)
- Email: `admin@novacart.com`
- Password: `admin123`

Change the password from the admin **Settings** tab, or override the defaults with environment variables (recommended for production):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `ADMIN_EMAIL` | `admin@novacart.com` | Admin login email (seeded on first run) |
| `ADMIN_PASSWORD` | `admin123` | Admin login password (seeded on first run) |
| `SESSION_SECRET` | random, generated at startup | Signs the admin session cookie |

## Deploying on Render

1. Push this repository to GitHub.
2. In Render, create a **New → Web Service**, select the repository.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`.
6. **Important:** SQLite writes to a local file that is reset on every deploy/restart. For a portfolio demo this is acceptable, but persistent data across restarts requires a managed PostgreSQL database or another ephemeral-friendly store.

The trust proxy setting is enabled and the session cookie is sent as `Secure` only in production (`NODE_ENV=production`, set automatically by Render) over HTTPS.

## Important production note
Checkout in this build creates a real order and updates inventory, but it is intentionally a demo checkout. For a production store, integrate a payment provider (e.g. Paystack/Flutterwave), email notifications, rate limiting, and a managed database.