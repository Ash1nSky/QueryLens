export const ANALYZER_SAMPLES: { name: string; sql: string }[] = [
  {
    name: 'Slow report query (many issues)',
    sql: `SELECT DISTINCT *
FROM orders o, customers c, products p
WHERE o.customer_id = c.id
  AND o.product_id = p.id
  AND YEAR(o.created_at) = 2024
  AND c.email LIKE '%@gmail.com'
  AND (o.status = 'shipped' OR o.status = 'delivered' OR o.status = 'returned')
  AND o.discount != NULL
  AND p.category_id NOT IN (SELECT id FROM categories WHERE archived = 1)
ORDER BY o.total DESC
LIMIT 20 OFFSET 5000;`,
  },
  {
    name: 'Clean aggregate with CTE',
    sql: `WITH monthly AS (
  SELECT customer_id, date_trunc('month', created_at) AS month, SUM(total) AS revenue
  FROM orders
  WHERE created_at >= :start_date AND status = 'paid'
  GROUP BY customer_id, date_trunc('month', created_at)
)
SELECT c.name, m.month, m.revenue,
       RANK() OVER (PARTITION BY m.month ORDER BY m.revenue DESC) AS rnk
FROM monthly m
JOIN customers c ON c.id = m.customer_id
ORDER BY m.month, rnk
LIMIT 100;`,
  },
  {
    name: 'N+1 scalar subqueries',
    sql: `SELECT u.id, u.name,
  (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
  (SELECT MAX(created_at) FROM posts p WHERE p.user_id = u.id) AS last_post
FROM users u
WHERE LOWER(u.email) = 'someone@example.com'
   OR u.username = 'someone';`,
  },
  {
    name: 'Dangerous UPDATE',
    sql: `UPDATE accounts SET balance = balance - 100, updated_at = NOW()`,
  },
  {
    name: 'DELETE with NOT IN',
    sql: `DELETE FROM sessions
WHERE user_id NOT IN (SELECT id FROM users)
  AND DATE(last_seen) = '2024-01-15';`,
  },
  {
    name: 'CREATE TABLE review',
    sql: `CREATE TABLE payments (
  payment_id INTEGER,
  order_id INTEGER,
  customer_id INTEGER,
  amount FLOAT,
  currency VARCHAR(255),
  note VARCHAR(255),
  provider VARCHAR(255)
);`,
  },
  {
    name: 'Pagination with UNION',
    sql: `SELECT id, title, 'article' AS kind FROM articles WHERE published = 1
UNION
SELECT id, title, 'video' AS kind FROM videos WHERE published = 1
ORDER BY id DESC
LIMIT 50;`,
  },
  {
    name: 'Dialect: PostgreSQL report',
    sql: `SELECT u."Email", lower(u.email) AS e, count(*) AS orders
FROM "Users" u
JOIN orders o ON o.user_id = u.id
WHERE date_trunc('day', o.created_at) = '2024-03-01'
  AND o.meta->>'channel' = 'web'
  AND u.status ILIKE 'act%'
GROUP BY u."Email", lower(u.email)
ORDER BY orders DESC
LIMIT 20 OFFSET 2000;`,
  },
  {
    name: 'Dialect: MySQL report',
    sql: `SELECT o.id, o.status, c.name, c.phone, SUM(o.total) AS revenue
FROM \`orders\` o
JOIN customers c ON c.id = o.customer_id
WHERE DATE_FORMAT(o.created_at, '%Y-%m') = '2024-03'
  AND c.phone = 9876543210
GROUP BY c.id
LIMIT 10, 20;`,
  },
  {
    name: 'Dialect: SQL Server report',
    sql: `SELECT TOP 50 o.OrderId, o.Status, c.Name
FROM dbo.Orders o WITH (NOLOCK)
JOIN dbo.Customers c ON c.CustomerId = o.CustomerId
WHERE ISNULL(o.Status, 'new') = 'new'
  AND c.Email = N'someone@example.com'
  AND DATEDIFF(day, o.CreatedAt, GETDATE()) < 30
  AND DATEADD(day, 7, o.ShippedAt) < GETDATE();`,
  },
  {
    name: 'Dialect: SQLite schema + query',
    sql: `CREATE TABLE events (
  id INT PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  kind VARCHAR(50),
  amount DECIMAL(10,2),
  created_at DATETIME
);`,
  },
];

export const PLAYGROUND_SCENARIOS: { name: string; description: string; sql: string }[] = [
  {
    name: 'E-commerce starter',
    description: 'Customers, products, orders and order items with foreign keys.',
    sql: `-- Schema
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  country TEXT DEFAULT 'US',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  price REAL NOT NULL CHECK (price >= 0),
  stock INTEGER DEFAULT 0
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'pending',
  total REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL
);

-- Data
INSERT INTO customers (name, email, country) VALUES
  ('Ada Lovelace', 'ada@example.com', 'UK'),
  ('Linus Torvalds', 'linus@example.com', 'FI'),
  ('Grace Hopper', 'grace@example.com', 'US'),
  ('Ken Thompson', 'ken@example.com', 'US');

INSERT INTO products (name, category, price, stock) VALUES
  ('Mechanical Keyboard', 'hardware', 129.99, 40),
  ('USB-C Hub', 'hardware', 49.50, 120),
  ('SQL Handbook', 'books', 39.00, 15),
  ('Noise-cancelling Headphones', 'audio', 249.00, 8),
  ('Standing Desk Mat', 'office', 59.00, 0);

INSERT INTO orders (customer_id, status, total) VALUES
  (1, 'paid', 169.49),
  (1, 'shipped', 39.00),
  (2, 'paid', 249.00),
  (3, 'pending', 129.99),
  (3, 'paid', 98.50);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 129.99), (1, 2, 1, 39.50),
  (2, 3, 1, 39.00),
  (3, 4, 1, 249.00),
  (4, 1, 1, 129.99),
  (5, 2, 2, 49.25);

-- Try a query
SELECT c.name, COUNT(o.id) AS orders, ROUND(SUM(o.total), 2) AS revenue
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id
ORDER BY revenue DESC;`,
  },
  {
    name: 'Learn: indexes & query plans',
    description: 'See a full scan turn into an index lookup.',
    sql: `CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- generate 2,000 rows with a recursive CTE
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
INSERT INTO events (user_id, kind, created_at)
SELECT (n % 50) + 1,
       CASE n % 4 WHEN 0 THEN 'click' WHEN 1 THEN 'view' WHEN 2 THEN 'purchase' ELSE 'signup' END,
       date('2024-01-01', '+' || (n % 365) || ' days')
FROM seq;

-- 1) Without an index: look at the plan → SCAN events
SELECT COUNT(*) FROM events WHERE user_id = 7 AND kind = 'click';

-- 2) Add an index
CREATE INDEX idx_events_user_kind ON events (user_id, kind);

-- 3) Same query: plan now says SEARCH ... USING INDEX
SELECT COUNT(*) FROM events WHERE user_id = 7 AND kind = 'click';`,
  },
  {
    name: 'Learn: variables & transactions',
    description: 'Session variables (@name) and BEGIN / ROLLBACK.',
    sql: `CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  balance INTEGER NOT NULL CHECK (balance >= 0)
);
INSERT INTO accounts (owner, balance) VALUES ('alice', 500), ('bob', 120);

-- Session variables (playground feature): typed and substituted into later statements
SET @amount = 200;
DECLARE @recipient TEXT = 'bob';
SET @today = date('now');

BEGIN;
UPDATE accounts SET balance = balance - @amount WHERE owner = 'alice';
UPDATE accounts SET balance = balance + @amount WHERE owner = @recipient;
SELECT *, @today AS transferred_on FROM accounts;
ROLLBACK;

-- Balances are back to the original values:
SELECT * FROM accounts;`,
  },
  {
    name: 'Blank database',
    description: 'Start from scratch.',
    sql: `-- Write any SQLite-compatible SQL here and press Run (Ctrl/⌘ + Enter).
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  done BOOLEAN DEFAULT 0
);
INSERT INTO notes (body) VALUES ('Learn SQL by doing'), ('Ship it');
SELECT * FROM notes;`,
  },
];
