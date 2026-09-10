# NovaCart — Full-stack E-commerce Portfolio Project

A portfolio-ready full-stack e-commerce demo: a customer storefront plus a server-side-protected admin dashboard, built with Node.js, Express and MySQL.

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
- MySQL 8+ / MariaDB 10.5+ via `mysql2`
- `express-session` with a MySQL session store (logins survive restarts)
- `bcryptjs` password hashing
- Vanilla JS front-end (no bundler), CSP security headers

## Run locally
1. Install Node.js 18+ and MySQL 8+ (or MariaDB 10.5+).
2. Create the database and a user (or adjust the variables below):

   ```sql
   CREATE DATABASE novacart CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'novacart'@'localhost' IDENTIFIED BY 'novacart';
   GRANT ALL PRIVILEGES ON novacart.* TO 'novacart'@'localhost';
   FLUSH PRIVILEGES;
   ```

3. From the project folder run `npm install`.
4. Configure the connection (see the variables table) — the defaults point at `novacart@localhost:3306/novacart`.
5. Run `npm start`.
6. Open http://localhost:3000
7. Admin dashboard: http://localhost:3000/admin

The schema, and a seed catalog with sample products and categories, are created automatically on the first run. The database can be connected with a single `DATABASE_URL` or individual `MYSQL_*` variables.

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
| `SESSION_SECRET` | `nova-local-dev-secret-change-me` | Signs the admin session cookie — set a strong value in production (`openssl rand -hex 32`) |
| `DATABASE_URL` | `mysql://user:pass@host:port/novacart` | Full MySQL connection string (overrides the `MYSQL_*` variables) |
| `MYSQL_HOST` | `localhost` | MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_USER` | `novacart` | MySQL user |
| `MYSQL_PASSWORD` | `` | MySQL password |
| `MYSQL_DATABASE` | `novacart` | MySQL database name |

## Deploying on Render

1. Push this repository to GitHub.
2. In Render, create a **New → Web Service**, select the repository.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add a MySQL database. Render does not offer a managed MySQL add-on, so use an external provider such as PlanetScale (MySQL-compatible), Railway, or Aiven, and pass its connection string as `DATABASE_URL`.
6. Add environment variables: `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`.

Thanks to the MySQL session store, any existing admin sessions remain valid after redeploys as long as the database is unchanged.

The trust proxy setting is enabled and the session cookie is sent as `Secure` only in production (`NODE_ENV=production`, set automatically by Render) over HTTPS.

## Important production note
Checkout in this build creates a real order and updates inventory, but it is intentionally a demo checkout. For a production store, integrate a payment provider (e.g. Paystack/Flutterwave), email notifications, rate limiting, and a managed database.