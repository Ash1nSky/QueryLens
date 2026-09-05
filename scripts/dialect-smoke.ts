/**
 * Quick manual check of the dialect rule packs.
 * Runs every sample through every dialect and prints the findings, rewrite notes and index DDL.
 *
 *   npm run check:dialects
 */
import { analyzeSql } from '../src/lib/analyzer';
import { DIALECT_LIST, detectDialect } from '../src/lib/dialects';

const cases: { name: string; sql: string }[] = [
  { name: 'report', sql: `SELECT DISTINCT * FROM orders o, customers c WHERE o.customer_id = c.id AND YEAR(o.created_at) = 2024 AND c.email LIKE '%@gmail.com' AND o.discount != NULL AND p.category_id NOT IN (SELECT id FROM categories WHERE archived = 1) ORDER BY o.total DESC LIMIT 20 OFFSET 5000;` },
  { name: 'pg-ish', sql: `SELECT u."Email", count(*) FROM "Users" u WHERE lower(u.email) = 'a@b.c' AND u.created_at::date = '2024-03-01' AND data->>'plan' = 'pro' GROUP BY u.email ORDER BY 2 DESC;` },
  { name: 'mysql-ish', sql: "SELECT o.id, o.status, c.name, SUM(o.total) FROM `orders` o JOIN customers c ON c.id = o.customer_id WHERE DATE_FORMAT(o.created_at, '%Y-%m') = '2024-03' AND c.phone = 9876543210 GROUP BY c.id LIMIT 10, 20;" },
  { name: 'mssql-ish', sql: `SELECT TOP 10 * FROM dbo.Orders o WITH (NOLOCK) WHERE ISNULL(o.status, 'x') = 'x' AND o.email = N'a@b.c' AND DATEDIFF(day, o.created_at, GETDATE()) < 30` },
  { name: 'sqlite-ish', sql: `SELECT * FROM events WHERE strftime('%Y', created_at) = '2024' AND name LIKE 'abc%' AND kind = "click"` },
  { name: 'ddl', sql: `CREATE TABLE payments (id INT PRIMARY KEY, order_id INT, amount FLOAT, note VARCHAR(255), created TIMESTAMP, uuid CHAR(36), flag BIT, big NVARCHAR(MAX), other NVARCHAR(MAX)) ENGINE=MyISAM CHARSET=utf8;` },
  { name: 'delete', sql: `DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day'` },
  { name: 'limit-order', sql: `SELECT id, name FROM users ORDER BY created_at DESC LIMIT 20` },
];

for (const c of cases) {
  console.log(`\n==================== ${c.name} ====================`);
  const d = detectDialect(c.sql);
  console.log('detected:', d ? `${d.id} (${d.reason})` : 'none');
  for (const dl of DIALECT_LIST) {
    const a = analyzeSql(c.sql, { dialect: dl.id });
    const own = a.issues.filter((i) => i.dialect === dl.id);
    console.log(`\n-- ${dl.label}: ${a.issues.length} findings, ${own.length} dialect-tagged`);
    for (const i of a.issues) console.log(`   [${i.severity}${i.dialect ? '·' + i.dialect : ''}] ${i.id}: ${i.title}${i.autoFixed ? ' (auto-fixed)' : ''}`);
    if (a.rewritten) console.log('   rewrite notes:', a.rewriteNotes.map((n) => n.slice(0, 70)).join(' | '));
    if (a.rewritten) console.log('   rewritten:', a.rewritten.replace(/\s+/g, ' ').slice(0, 300));
    if (a.indexSuggestions.length) console.log('   index:', a.indexSuggestions[0].ddl);
  }
}
