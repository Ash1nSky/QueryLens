import type { DialectPack, RuleContext } from './types';
import { COL, applyRewrites, call, dayRange, doubleQuotedStringLiteral, monthRange, reportForeignSyntax, yearRange } from './shared';

const ENGINE = 'SQLite';

function rules(ctx: RuleContext): void {
  const { a, code } = ctx;

  // ---- syntax from other engines that SQLite rejects ----
  reportForeignSyntax(ctx, 'lite-foreign-syntax', ENGINE, [
    { when: /\bSELECT\s+(DISTINCT\s+)?TOP\s*\(?\s*\d+/i, what: '`SELECT TOP n`', use: '`LIMIT n`', from: 'SQL Server' },
    { when: /\bFETCH\s+(FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY/i, what: '`FETCH FIRST n ROWS ONLY`', use: '`LIMIT n [OFFSET m]`', from: 'standard SQL' },
    { when: /\bILIKE\b/i, what: '`ILIKE`', use: '`LIKE` — it is already case-insensitive for ASCII (or `col = ? COLLATE NOCASE`)', from: 'PostgreSQL' },
    { when: /::\s*[A-Za-z]/, what: 'the `::type` cast operator', use: '`CAST(expr AS type)`', from: 'PostgreSQL' },
    { when: call('CONCAT') , what: '`CONCAT()`', use: '`||` (supported natively since 3.44, 2023)', from: 'MySQL/SQL Server' },
    { when: /(?<![\w.])ISNULL\s*\([^()]*,/i, what: 'two-argument `ISNULL()`', use: '`IFNULL()` / `COALESCE()`', from: 'SQL Server' },
    { when: call('NVL'), what: '`NVL()`', use: '`IFNULL()` / `COALESCE()`', from: 'Oracle' },
    { when: call('NOW', 'GETDATE', 'SYSDATETIME', 'CURDATE'), what: '`NOW()` / `GETDATE()`', use: '`CURRENT_TIMESTAMP`, `datetime(\'now\')`, `date(\'now\')`', from: 'MySQL/SQL Server' },
    { when: call('YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'DAYOFWEEK'), what: '`YEAR()` / `MONTH()` / `DAY()` functions', use: '`strftime(\'%Y\', col)` — or better, a text/ISO-8601 range comparison', from: 'MySQL/SQL Server' },
    { when: call('EXTRACT', 'DATE_PART', 'DATEPART'), what: '`EXTRACT()` / `date_part()` / `DATEPART()`', use: '`strftime(\'%m\', col)` etc.', from: 'PostgreSQL/SQL Server' },
    { when: call('DATE_TRUNC', 'DATETRUNC'), what: '`DATE_TRUNC()`', use: '`date(col, \'start of month\')` / `strftime()`', from: 'PostgreSQL/SQL Server' },
    { when: call('DATE_FORMAT', 'TO_CHAR', 'FORMAT'), what: '`DATE_FORMAT()` / `TO_CHAR()` / `FORMAT()`', use: '`strftime(format, col)`', from: 'MySQL/PostgreSQL/SQL Server' },
    { when: call('DATEADD', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF'), what: '`DATEADD()` / `DATE_ADD()` / `DATEDIFF()`', use: '`date(col, \'+30 days\')`, `julianday(a) - julianday(b)`', from: 'MySQL/SQL Server' },
    { when: /\bINTERVAL\s+'?\d+'?\s+(DAY|MONTH|YEAR|HOUR|MINUTE|SECOND)S?\b/i, what: '`INTERVAL n unit` arithmetic', use: '`datetime(col, \'+1 day\')` modifiers', from: 'MySQL/PostgreSQL' },
    { when: call('LEN', 'CHAR_LENGTH', 'DATALENGTH'), what: '`LEN()` / `CHAR_LENGTH()`', use: '`length()`', from: 'SQL Server/MySQL' },
    { when: call('CHARINDEX', 'LOCATE', 'STRPOS', 'POSITION'), what: '`CHARINDEX()` / `LOCATE()` / `STRPOS()`', use: '`instr(str, sub)`', from: 'SQL Server/MySQL/PostgreSQL' },
    { when: call('STRING_AGG', 'ARRAY_AGG', 'LISTAGG'), what: '`STRING_AGG()` / `ARRAY_AGG()`', use: '`group_concat(expr, sep)` (or `string_agg` alias since 3.44)', from: 'PostgreSQL/SQL Server' },
    { when: /(?<![\w.])IF\s*\(/i, what: 'the `IF()` function', use: '`IIF()` (3.32+) or `CASE WHEN … END`', from: 'MySQL' },
    { when: call('NEWID', 'UUID', 'GEN_RANDOM_UUID'), what: '`NEWID()` / `UUID()`', use: '`lower(hex(randomblob(16)))` or generate ids in the application', from: 'SQL Server/MySQL/PostgreSQL' },
    { when: call('CONVERT'), what: '`CONVERT(type, expr)`', use: '`CAST(expr AS type)`', from: 'SQL Server' },
    { when: call('SPLIT_PART', 'SUBSTRING_INDEX', 'STRING_SPLIT'), what: 'string-splitting functions', use: 'a recursive CTE or the `json_each()` table-valued function', from: 'PostgreSQL/MySQL/SQL Server' },
    { when: /\bREGEXP_LIKE\s*\(|~\*?\s*'/i, what: '`REGEXP_LIKE()` / `~`', use: 'the `REGEXP` operator — but only if the application registers a `regexp()` function', from: 'MySQL/PostgreSQL' },
    { when: /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i, what: '`ON DUPLICATE KEY UPDATE`', use: '`ON CONFLICT (key) DO UPDATE SET col = excluded.col` (3.24+)', from: 'MySQL' },
    { when: /\bINSERT\s+IGNORE\b/i, what: '`INSERT IGNORE`', use: '`INSERT OR IGNORE`', from: 'MySQL' },
    { when: /\bAUTO_INCREMENT\b/i, what: '`AUTO_INCREMENT`', use: '`INTEGER PRIMARY KEY` (rowid alias) — `AUTOINCREMENT` is one word and rarely needed', from: 'MySQL' },
    { when: /\b(BIG|SMALL)?SERIAL\b|\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)|\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i, what: '`SERIAL` / `IDENTITY`', use: '`INTEGER PRIMARY KEY`', from: 'PostgreSQL/SQL Server' },
    { when: /\bENGINE\s*=|\bCHARSET\s*=|\bCHARACTER\s+SET\b/i, what: '`ENGINE=` / `CHARSET=` table options', use: 'nothing — SQLite stores UTF-8 (or UTF-16) per database', from: 'MySQL' },
    { when: /\bWITH\s*\(\s*NOLOCK\s*\)|\bNOLOCK\b/i, what: '`WITH (NOLOCK)`', use: 'nothing — use WAL mode (`PRAGMA journal_mode=WAL`) so readers do not block the writer', from: 'SQL Server' },
    { when: /\bDISTINCT\s+ON\s*\(/i, what: '`DISTINCT ON (…)`', use: '`ROW_NUMBER() OVER (PARTITION BY …)` (3.25+) or the bare-column trick with `MIN()`/`MAX()`', from: 'PostgreSQL' },
    { when: /\bLATERAL\b/i, what: '`LATERAL`', use: 'a correlated subquery in the SELECT list, or a plain JOIN', from: 'PostgreSQL' },
    { when: /\bCREATE\s+INDEX\s+CONCURRENTLY\b|\bWITH\s*\(\s*ONLINE\s*=\s*ON\s*\)/i, what: 'online index build options', use: 'plain `CREATE INDEX` — SQLite has one writer at a time anyway', from: 'PostgreSQL/SQL Server' },
    { when: /\bUSING\s+(GIN|GIST|BRIN|HASH|BTREE)\b/i, what: '`USING gin/gist/hash`', use: 'plain B-tree indexes, or the FTS5 / R*Tree virtual tables', from: 'PostgreSQL/MySQL' },
    { when: /\bDECLARE\s+@\w+/i, what: '`DECLARE @var`', use: 'bound parameters (`?`, `:name`, `@name`) — SQLite has no variables', from: 'SQL Server' },
    { when: /\bALTER\s+TABLE\s+\w+\s+(DROP\s+CONSTRAINT|ALTER\s+COLUMN|MODIFY\s+COLUMN|CHANGE\s+COLUMN|ADD\s+CONSTRAINT|ADD\s+(PRIMARY|FOREIGN)\s+KEY)/i, what: '`ALTER TABLE … ALTER/MODIFY COLUMN / ADD|DROP CONSTRAINT`', use: 'the 12-step rebuild: create new table, copy rows, drop old, rename (only ADD COLUMN, RENAME, DROP COLUMN (3.35+) are supported)', from: 'MySQL/PostgreSQL/SQL Server' },
    { when: /\bTRUNCATE\s+TABLE\b/i, what: '`TRUNCATE TABLE`', use: '`DELETE FROM t;` — SQLite\'s truncate optimisation makes an unconditional DELETE just as fast', from: 'all other engines' },
    { when: /\bRIGHT\s+(OUTER\s+)?JOIN\b|\bFULL\s+(OUTER\s+)?JOIN\b/i, what: '`RIGHT JOIN` / `FULL OUTER JOIN`', use: 'supported since SQLite 3.39 (June 2022); on older versions swap the tables to a LEFT JOIN or use `UNION ALL`', from: 'note' },
    { when: (c) => /\bBOOLEAN\b/i.test(c.code) && c.a.statementType === 'CREATE TABLE', what: '`BOOLEAN` column type', use: '`INTEGER` holding 0/1 — BOOLEAN is accepted but has NUMERIC affinity and no enforcement (unless the table is `STRICT`)', from: 'note' },
  ]);

  // ---- double-quoted "string" ----
  const dq = doubleQuotedStringLiteral(ctx);
  if (dq) ctx.add({ id: 'lite-double-quoted-string', severity: 'high', category: 'correctness', title: `${dq} is treated as a string only by accident`, description: `Double quotes mean *identifier*; SQLite falls back to a string literal only when no such column exists (a legacy misfeature that \`SQLITE_DQS=0\` disables). If a column named ${dq.replace(/"/g, '')} ever appears, the query silently changes meaning.`, suggestion: `Use single quotes: '${dq.slice(1, -1)}'.` });

  // ---- type affinity ----
  if (a.statementType === 'CREATE TABLE') {
    if (!/\bSTRICT\b/i.test(code)) {
      const declared = ctx.columns.filter((c) => c.type !== 'ANY');
      if (declared.length) ctx.add({ id: 'lite-type-affinity', severity: 'info', category: 'correctness', title: 'Column types are only affinities, not constraints', description: `SQLite will happily store \`'abc'\` in an INTEGER column and \`123\` in TEXT — declared types just set a preferred affinity. \`VARCHAR(50)\` does not limit length either.`, suggestion: 'Add `STRICT` after the closing parenthesis (3.37+) to enforce INT/INTEGER/REAL/TEXT/BLOB/ANY, or add `CHECK (typeof(col) = \'integer\')` constraints.' });
    }
    ctx.remove('untyped-column');
    const intPk = ctx.columns.find((c) => c.flags.includes('PK') && /^INT$/.test(c.type));
    if (intPk) ctx.add({ id: 'lite-int-pk', severity: 'high', category: 'performance', title: `\`${intPk.name} INT PRIMARY KEY\` is not a rowid alias`, description: 'Only the exact spelling `INTEGER PRIMARY KEY` becomes the table\'s rowid. `INT PRIMARY KEY` creates a separate unique index, doubles storage for the key, and allows NULLs in the primary key.', suggestion: `Write \`${intPk.name} INTEGER PRIMARY KEY\`.` });
    if (/\bAUTOINCREMENT\b/i.test(code)) ctx.add({ id: 'lite-autoincrement', severity: 'low', category: 'performance', title: 'AUTOINCREMENT is usually unnecessary', description: 'It adds a write to the `sqlite_sequence` table on every insert. Plain `INTEGER PRIMARY KEY` already auto-assigns max(rowid)+1; AUTOINCREMENT only guarantees that deleted ids are never reused.', suggestion: 'Drop it unless id reuse would be a bug (e.g. ids referenced externally after deletion).' });
    const textPk = ctx.columns.find((c) => c.flags.includes('PK') && /^(TEXT|VARCHAR|CHAR)/.test(c.type));
    if (textPk && !/\bWITHOUT\s+ROWID\b/i.test(code)) ctx.add({ id: 'lite-without-rowid', severity: 'low', category: 'performance', title: 'Text primary key on a rowid table', description: `\`${textPk.name}\` is stored twice: once in the hidden rowid table and once in the automatic unique index. Lookups by the key do two B-tree searches.`, suggestion: 'Declare the table `WITHOUT ROWID` so the primary key becomes the clustering key (best when rows are small and the PK is not a huge blob).' });
    if (ctx.columns.some((c) => c.flags.includes('FK')) || /FOREIGN\s+KEY/i.test(code)) ctx.add({ id: 'lite-fk-pragma', severity: 'medium', category: 'correctness', title: 'Foreign keys are not enforced unless PRAGMA foreign_keys = ON', description: 'By default SQLite parses but ignores REFERENCES clauses. Every connection must run `PRAGMA foreign_keys = ON;` (it is per-connection and cannot be set inside a transaction).', suggestion: 'Enable it in your connection setup (most ORMs/drivers have an option) and add an index on each FK column — SQLite does not create one.' });
    ctx.amend('fk-index', { severity: 'medium', description: 'SQLite does NOT index foreign-key columns. Without an index, every DELETE on the parent triggers a full scan of the child table to check the constraint.' });
    if (ctx.columns.some((c) => /^(DATETIME|TIMESTAMP|DATE)$/.test(c.type))) ctx.add({ id: 'lite-no-date-type', severity: 'info', category: 'correctness', title: 'No native DATE/DATETIME type', description: 'These names get NUMERIC affinity; values are stored as whatever you insert (TEXT ISO-8601, REAL julian day, or INTEGER unix epoch). Mixing formats breaks comparisons and `strftime()`.', suggestion: 'Pick one convention — `TEXT` in `YYYY-MM-DD HH:MM:SS` UTC sorts and compares correctly — and stick to it.' });
    if (ctx.columns.some((c) => /^(DECIMAL|NUMERIC)\(/.test(c.type) && /(price|amount|total|cost|balance|salary)/i.test(c.name))) ctx.add({ id: 'lite-decimal-is-real', severity: 'high', category: 'correctness', title: 'DECIMAL is stored as floating point', description: '`DECIMAL(10,2)` gets NUMERIC affinity, which stores values as 8-byte IEEE doubles — 0.1 + 0.2 ≠ 0.3. There is no exact decimal type.', suggestion: 'Store integer minor units (cents) in an INTEGER column, or use the `decimal` extension.' });
    ctx.amend('no-pk', { description: 'Without a declared primary key the table still has an implicit rowid, but it can change on VACUUM and is not stable for external references. Declare `id INTEGER PRIMARY KEY`.' });
    ctx.amend('varchar255', { description: 'SQLite ignores the length entirely — `VARCHAR(255)` is just TEXT affinity. Write `TEXT` and add a `CHECK (length(col) <= 255)` if the limit matters.' });
  }

  // ---- LIKE / case sensitivity ----
  if (a.conditions.some((c) => c.op === 'LIKE' && !/^'%/.test(c.value ?? '')) && !/\bCOLLATE\s+NOCASE\b/i.test(code)) ctx.add({ id: 'lite-like-index', severity: 'medium', category: 'performance', title: 'LIKE cannot use an index unless the column is COLLATE NOCASE', description: 'The default `LIKE` is case-insensitive for ASCII, which does not match a BINARY-collated index, so even `LIKE \'abc%\'` scans. (The `case_sensitive_like` pragma or `GLOB` changes this.)', suggestion: 'Declare or index the column with `COLLATE NOCASE` (`CREATE INDEX … ON t (col COLLATE NOCASE)`), or use `GLOB \'abc*\'` which is case-sensitive and can use a normal index.' });
  for (const fn of ['LOWER', 'UPPER']) ctx.amend(`fn-on-column-${fn}`, { suggestion: 'Use `col = ? COLLATE NOCASE` with a NOCASE index, or an expression index `CREATE INDEX … ON t (lower(col))` (3.9+). Note SQLite\'s built-in `lower()` only folds ASCII unless the ICU extension is loaded.' });
  for (const fn of ['DATE', 'DATETIME', 'STRFTIME']) ctx.amend(`fn-on-column-${fn}`, { suggestion: 'Compare the raw text column against ISO-8601 bounds (`col >= \'2024-03-01\' AND col < \'2024-04-01\'`) — string comparison on ISO dates is correct and uses the index.' });
  if (/\bSTRFTIME\s*\(\s*'[^']*'\s*,\s*[\w."]+\s*\)\s*(=|<>|!=|>|<|>=|<=|IN|LIKE)/i.test(ctx.sql)) ctx.fnIssue(['STRFTIME'], { id: 'lite-strftime-where', severity: 'high', category: 'performance', title: 'strftime() on a column in WHERE (non-sargable)', description: 'The function runs for every row and its text result blocks index use on the underlying column.', suggestion: 'Use an ISO-8601 text range on the raw column: `col >= \'2024-01-01\' AND col < \'2025-01-01\'`.' });

  // ---- concurrency / transactions ----
  if (a.statementType === 'UPDATE' || a.statementType === 'DELETE' || a.statementType === 'INSERT') {
    if (ctx.has('single-insert')) ctx.amend('single-insert', { severity: 'medium', title: 'Single-row insert outside a transaction', description: 'Without an explicit transaction every statement is its own fsync\'d transaction — SQLite can do only tens of those per second on spinning disks (hundreds on SSD). Wrapping 1,000 inserts in `BEGIN … COMMIT` is typically 50–100× faster.' });
    ctx.amend('delete-batch', { description: 'SQLite holds the single write lock for the whole statement and a huge DELETE grows the journal/WAL. Batch with `DELETE FROM t WHERE rowid IN (SELECT rowid FROM t WHERE … LIMIT 5000)` — or `DELETE … LIMIT` if compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.' });
    ctx.amend('update-join', { description: 'SQLite supports `UPDATE t SET … FROM other WHERE …` since 3.33 (2020); older versions need correlated subqueries in SET.' });
  }

  // ---- amend generic findings ----
  ctx.amend('agg-without-group', { severity: 'medium', description: (i) => i.description.replace(/Most databases reject this;.*$/, 'SQLite allows this and takes the "bare" column from an arbitrary row — except with a lone MIN()/MAX(), where it comes from the row holding the min/max (a documented feature). Not portable.') });
  ctx.amend('or-conditions', { suggestion: 'SQLite can use a separate index for each OR branch (a "multi-index OR" — `EXPLAIN QUERY PLAN` shows `MULTI-INDEX OR`) if every branch is indexable; otherwise it scans. Splitting into `UNION ALL` is the safe alternative.' });
  ctx.amend('double-wildcard', { suggestion: 'Use an FTS5 virtual table (`CREATE VIRTUAL TABLE docs USING fts5(body)`) with `MATCH` for real text search; `LIKE \'%term%\'` always scans.' });
  ctx.amend('leading-wildcard', { suggestion: 'Use FTS5 for search, or a `GLOB` on a reversed copy of the column if you only need suffix matching.' });
  ctx.amend('scalar-subquery', { suggestion: 'SQLite runs a correlated scalar subquery once per outer row (it has no decorrelation). Pre-aggregate in a CTE and `LEFT JOIN` it.' });
  ctx.amend('in-subquery', { description: 'SQLite materialises the subquery into an ephemeral index once (`USING ... SUBQUERY` in EXPLAIN QUERY PLAN) — fine. Correlated subqueries, however, re-run per row.' });
  ctx.amend('not-in-subquery', { description: (i) => i.description + ' SQLite also has no anti-join optimisation for NOT IN, so `NOT EXISTS` or a `LEFT JOIN … IS NULL` is both safer and faster.' });
  ctx.amend('order-random', { suggestion: '`ORDER BY random()` sorts the whole table in a temp B-tree. For a single row use `WHERE rowid >= (abs(random()) % (SELECT max(rowid) FROM t)) LIMIT 1`.' });
  ctx.amend('large-offset', { suggestion: 'Use keyset pagination on rowid / an indexed column: `WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT n` (row-value comparison since 3.15).' });
  ctx.amend('large-in-list', { suggestion: 'Bind the list as JSON and use `WHERE id IN (SELECT value FROM json_each(?))` — one prepared statement regardless of list size, and it stays under `SQLITE_MAX_VARIABLE_NUMBER` (999 in old builds).' });
  ctx.amend('count-distinct', { description: 'Builds an ephemeral B-tree of the distinct values. There is no approximate alternative in SQLite; cache the result if it is for a dashboard.' });
  ctx.amend('destructive', { description: 'Double-check target and environment. SQLite DDL is fully transactional — wrap it in `BEGIN; … ROLLBACK/COMMIT;` and you can undo a mistaken DROP.' });
  ctx.amend('index-locking', { severity: 'info', title: 'CREATE INDEX holds the database write lock', description: 'SQLite has a single writer, so the index build blocks other writers (readers continue in WAL mode). On a large table run it during a quiet period.' , suggestion: undefined });
  ctx.amend('index-writes', { description: 'INSERT/UPDATE/DELETE must maintain it. Use `PRAGMA index_list(t)` and `EXPLAIN QUERY PLAN` to confirm it is used; `.expert` in the CLI can suggest indexes for a workload.' });
  ctx.amend('alter-lock', { severity: 'high', title: 'SQLite supports only a few ALTER TABLE forms', description: 'Only `RENAME`, `ADD COLUMN`, `DROP COLUMN` (3.35+) and `RENAME COLUMN` (3.25+) exist. Changing a type, adding a constraint, or reordering columns requires creating a new table, copying rows and renaming — with `PRAGMA foreign_keys=OFF` around it.' });
  ctx.amend('looks-good', { description: 'The query structure is sound. Verify with `EXPLAIN QUERY PLAN` that you see `SEARCH … USING INDEX` rather than `SCAN` — the Playground tab does this for you.' });
  ctx.amend('limit-no-order', { description: 'Without ORDER BY, SQLite returns rows in rowid or index order — which changes as soon as the planner picks a different index.' });
  ctx.amend('implicit-cast', { description: (i) => i.description + ' In SQLite the outcome depends on affinity: an INTEGER column compared with \'42\' converts the text, but a TEXT column compared with 42 does not match \'42\' at all.' });
  ctx.amend('order-not-selected', { severity: 'info', description: 'SQLite permits ordering by a column that is not in the SELECT DISTINCT list; the result is well-defined but not portable to PostgreSQL/SQL Server.' });
  ctx.amend('right-join', { description: 'RIGHT JOIN requires SQLite 3.39 (2022-06) and is always rewritten as a LEFT JOIN internally — write the LEFT JOIN yourself for compatibility with older embedded versions.' });
  ctx.amend('union-all', { description: (i) => i.description + ' SQLite implements UNION with a temp B-tree (`USE TEMP B-TREE FOR UNION` in EXPLAIN QUERY PLAN).' });
}

function rewrite(sql: string) {
  return applyRewrites(sql, [
    { re: new RegExp(String.raw`\bSTRFTIME\s*\(\s*'%Y'\s*,\s*${COL}\s*\)\s*=\s*'(\d{4})'`, 'gi'), to: (_m, col, y) => yearRange(col, y), note: 'Rewrote `strftime(\'%Y\', col) = y` as an ISO-8601 text range so an index on the column can be used.', fixes: 'lite-strftime-where' },
    { re: new RegExp(String.raw`\bSTRFTIME\s*\(\s*'%Y-%m'\s*,\s*${COL}\s*\)\s*=\s*'(\d{4}-\d{2})'`, 'gi'), to: (_m, col, ym) => monthRange(col, ym), note: 'Rewrote `strftime(\'%Y-%m\', col) = m` as an ISO-8601 text range.', fixes: 'lite-strftime-where' },
    { re: new RegExp(String.raw`\bSTRFTIME\s*\(\s*'%Y-%m-%d'\s*,\s*${COL}\s*\)\s*=\s*'(\d{4}-\d{2}-\d{2})'`, 'gi'), to: (_m, col, d) => dayRange(col, d), note: 'Rewrote `strftime(\'%Y-%m-%d\', col) = d` as an ISO-8601 text range.', fixes: 'lite-strftime-where' },
    { re: /\bTRUNCATE\s+TABLE\s+([\w."]+)\s*;?\s*$/i, to: 'DELETE FROM $1', note: 'Replaced `TRUNCATE TABLE` (unsupported) with an unconditional `DELETE FROM`, which SQLite optimises the same way.', fixes: 'lite-foreign-syntax' },
    { re: /\bINSERT\s+IGNORE\s+INTO\b/gi, to: 'INSERT OR IGNORE INTO', note: 'Replaced MySQL `INSERT IGNORE` with SQLite `INSERT OR IGNORE`.', fixes: 'lite-foreign-syntax' },
    { re: /\bAUTO_INCREMENT\b/gi, to: 'AUTOINCREMENT', note: 'Replaced `AUTO_INCREMENT` with SQLite `AUTOINCREMENT` (consider dropping it entirely — `INTEGER PRIMARY KEY` auto-assigns).', fixes: 'lite-foreign-syntax' },
  ]);
}

export const sqlite: DialectPack = {
  info: { id: 'sqlite', label: 'SQLite', short: 'LITE', promptName: 'SQLite', formatter: 'sqlite', description: 'Type affinity, rowid aliases, PRAGMA foreign_keys, NOCASE, WAL, STRICT tables' },
  rules,
  rewrite,
  indexDdl: ({ table, name, columns }) => `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(', ')});`,
  explainTip: 'EXPLAIN QUERY PLAN',
};
