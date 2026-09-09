# NovaCart 2.0 — Full-stack E-commerce Portfolio Project

This version is a portfolio-ready full-stack demo with a customer storefront and admin dashboard.

## Included
- Clothes, shoes, jewelry, accessories and bags
- Random premium stock photography from Unsplash
- Product search and category filters
- Product cards and responsive storefront
- Shopping cart with quantity controls
- SQLite database
- REST API with Express
- Real inventory decrement when an order is placed
- Order creation and order-items tables
- Admin dashboard
- Product CRUD (create, edit, delete)
- Stock monitoring
- Revenue, order, customer and product statistics
- Category analytics
- Recent orders
- Mobile responsive layout

## Run locally
1. Install Node.js 18+.
2. Open this project folder in a terminal.
3. Run `npm install`.
4. Run `npm start`.
5. Open http://localhost:3000
6. Admin dashboard: http://localhost:3000/admin.html

The SQLite database `novacart.db` is created automatically on first run.

## Important production note
Checkout in this portfolio build creates an order and updates inventory, but it is intentionally a demo checkout. For a real store, connect a secure payment provider (for example Paystack/Flutterwave), authentication, email notifications, server-side validation, HTTPS, proper admin authorization and production database hosting.
