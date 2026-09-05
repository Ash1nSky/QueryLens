import type { DialectPack, RuleContext } from './types';
import { COL, applyRewrites, call, dayRange, doubleQuotedStringLiteral, extractYearRules, monthRange, reportForeignSyntax, yearRange } from './shared';

const ENGINE = 'PostgreSQL';

function rules(ctx: RuleContext): void {
  const { a, code } = ctx;

  // ---- syntax from other engines that PostgreSQL rejects ----
  reportForeignSyntax(ctx, 'pg-foreign-syntax', ENGINE, [
    { when: /`[^`]+`/, what: 'backtick-quoted identifiers', use: 'double quotes ("name") or, better, lowercase snake_case without quotes', from: 'MySQL' },
    { when: /\[[A-Za-z_][\w ]*\]/, what: 'square-bracket identifiers', use: 'double quotes', from: 'SQL Server' },
    { when: /\bLIMIT\s+\d+\s*,\s*\d+/i, what: '`LIMIT offset, count`', use: '`LIMIT count OFFSET offset`', from: 'MySQL' },
    { when: /\bSELECT\s+(DISTINCT\s+)?TOP\s*\(?\s*\d+/i, what: '`SELECT TOP n`', use: '`LIMIT n` or `FETCH FIRST n ROWS ONLY`', from: 'SQL Server' },
    { when: call('IFNULL'), what: '`IFNULL()`', use: '`COALESCE()`', from: 'MySQL/SQLite' },
    { when: /(?<![\w.])ISNULL\s*\([^()]*,/i, what: 'two-argument `ISNULL()`', use: '`COALESCE()`', from: 'SQL Server' },
    { when: call('GETDATE', 'SYSDATETIME', 'GETUTCDATE'), what: '`GETDATE()`', use: '`NOW()` / `CURRENT_TIMESTAMP` / `CLOCK_TIMESTAMP()`', from: 'SQL Server' },
    { when: call('DATEADD', 'DATEDIFF', 'DATEPART', 'DATENAME'), what: '`DATEADD()` / `DATEDIFF()` / `DATEPART()`', use: 'interval arithmetic (`col + INTERVAL \'1 day\'`), subtraction of timestamps, `EXTRACT()`', from: 'SQL Server/MySQL' },
    { when: call('YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'DAYOFWEEK', 'WEEKDAY'), what: '`YEAR()` / `MONTH()` / `DAY()` functions', use: '`EXTRACT(YEAR FROM col)` or `date_part()` — or better, a date range', from: 'MySQL/SQL Server' },
    { when: call('DATE_FORMAT', 'STR_TO_DATE'), what: '`DATE_FORMAT()` / `STR_TO_DATE()`', use: '`TO_CHAR()` / `TO_DATE()` / `TO_TIMESTAMP()`', from: 'MySQL' },
    { when: call('LEN'), what: '`LEN()`', use: '`LENGTH()` / `CHAR_LENGTH()`', from: 'SQL Server' },
    { when: call('CHARINDEX', 'LOCATE', 'INSTR'), what: '`CHARINDEX()` / `LOCATE()` / `INSTR()`', use: '`POSITION(sub IN str)` / `STRPOS()`', from: 'SQL Server/MySQL' },
    { when: /(?<![\w.])IF\s*\(/i, what: 'the `IF()` function', use: '`CASE WHEN … THEN … ELSE … END`', from: 'MySQL' },
    { when: call('IIF'), what: '`IIF()`', use: '`CASE WHEN … END`', from: 'SQL Server' },
    { when: call('NEWID', 'UUID'), what: '`NEWID()` / `UUID()`', use: '`gen_random_uuid()`', from: 'SQL Server/MySQL' },
    { when: call('CONVERT'), what: '`CONVERT(type, expr)`', use: '`CAST(expr AS type)` or `expr::type`', from: 'SQL Server' },
    { when: call('GROUP_CONCAT'), what: '`GROUP_CONCAT()`', use: '`STRING_AGG(expr, sep ORDER BY …)`', from: 'MySQL/SQLite' },
    { when: call('SUBSTRING_INDEX'), what: '`SUBSTRING_INDEX()`', use: '`SPLIT_PART()`', from: 'MySQL' },
    { when: call('STRFTIME'), what: '`STRFTIME()`', use: '`TO_CHAR()`', from: 'SQLite' },
    { when: /\bAUTO_?INCREMENT\b/i, what: '`AUTO_INCREMENT`', use: '`GENERATED ALWAYS AS IDENTITY` (or `BIGSERIAL`)', from: 'MySQL/SQLite' },
    { when: /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i, what: '`IDENTITY(1,1)`', use: '`GENERATED ALWAYS AS IDENTITY`', from: 'SQL Server' },
    { when: /\bENGINE\s*=/i, what: '`ENGINE=…` table option', use: 'nothing — PostgreSQL has a single storage engine', from: 'MySQL' },
    { when: /\b(TINYINT|MEDIUMINT|UNSIGNED|DATETIME2?|NVARCHAR|NCHAR|LONGTEXT|MEDIUMTEXT|TINYTEXT|UNIQUEIDENTIFIER|BIT\s*\(\s*\d+\s*\))\b/i, what: 'non-PostgreSQL column types (TINYINT/UNSIGNED/DATETIME/NVARCHAR/…)', use: '`SMALLINT`, `INTEGER`/`BIGINT` with a CHECK for unsigned, `TIMESTAMPTZ`, `TEXT`/`VARCHAR`, `UUID`', from: 'MySQL/SQL Server' },
    { when: /\bWITH\s*\(\s*NOLOCK\s*\)|\bNOLOCK\b/i, what: '`WITH (NOLOCK)`', use: 'nothing — PostgreSQL readers never block writers (MVCC)', from: 'SQL Server' },
    { when: /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i, what: '`ON DUPLICATE KEY UPDATE`', use: '`ON CONFLICT (key) DO UPDATE SET col = EXCLUDED.col`', from: 'MySQL' },
    { when: /\bREPLACE\s+INTO\b/i, what: '`REPLACE INTO`', use: '`INSERT … ON CONFLICT DO UPDATE`', from: 'MySQL/SQLite' },
    { when: /\bINSERT\s+(OR\s+)?IGNORE\b/i, what: '`INSERT IGNORE`', use: '`INSERT … ON CONFLICT DO NOTHING`', from: 'MySQL/SQLite' },
    { when: /\bREGEXP\b|\bRLIKE\b/i, what: '`REGEXP` / `RLIKE`', use: 'the `~` / `~*` operators or `regexp_like()` (PG 15+)', from: 'MySQL/SQLite' },
    { when: /\bSELECT\b[\s\S]*?\bINTO\s+#?\w+\s+FROM\b/i, what: '`SELECT … INTO table FROM`', use: '`CREATE TABLE new AS SELECT …`', from: 'SQL Server' },
    { when: /\bDECLARE\s+@\w+/i, what: '`DECLARE @var`', use: 'a `DO $$ … $$` block, a function, or psql `\\set` variables', from: 'SQL Server/MySQL' },
    { when: /\bWITH\s*\(\s*(INDEX|FORCESEEK|READUNCOMMITTED|HOLDLOCK|UPDLOCK)/i, what: 'table hints', use: 'nothing — PostgreSQL has no hints (see pg_hint_plan if you must)', from: 'SQL Server' },
    { when: /\bSTRAIGHT_JOIN\b|\b(USE|FORCE|IGNORE)\s+INDEX\b/i, what: 'index hints', use: 'nothing — adjust statistics or the query instead', from: 'MySQL' },
    { when: /\bDATE_TRUNC\s*\(\s*(?!')/i, what: '`DATE_TRUNC(unit, col)` with an unquoted unit', use: '`DATE_TRUNC(\'day\', col)` — the unit is a string in PostgreSQL', from: 'SQL Server 2022/BigQuery' },
  ]);

  // ---- double-quoted "string" ----
  const dq = doubleQuotedStringLiteral(ctx);
  if (dq) ctx.add({ id: 'pg-double-quoted-string', severity: 'critical', category: 'correctness', title: `${dq} is an identifier in PostgreSQL, not a string`, description: `Double quotes delimit identifiers. \`${dq}\` will be looked up as a column name and fail with \`column ${dq.replace(/"/g, '')} does not exist\`.`, suggestion: `Use single quotes for string literals: '${dq.slice(1, -1)}'.` });

  // ---- '+' used for string concatenation ----
  if (/'[^']*'\s*\+\s*[\w."]|[\w."]\s*\+\s*'[^']*'/.test(ctx.sql) && !/\bINTERVAL\b/i.test(code)) ctx.add({ id: 'pg-plus-concat', severity: 'high', category: 'correctness', title: '`+` between a string and another value', description: 'PostgreSQL has no `+` operator for text — this raises `operator does not exist: text + …` (or silently adds numbers if both sides are numeric).', suggestion: 'Use `||` or `CONCAT()` for string concatenation.' });

  // ---- identifier case folding ----
  const unquotedCamel = ctx.tokens.filter((t) => t.type === 'identifier' && !/^["`[]/.test(t.value) && /[a-z]/.test(t.value) && /[A-Z]/.test(t.value) && /^[A-Za-z_]\w*$/.test(t.value)).map((t) => t.value);
  const quotedCamel = ctx.tokens.filter((t) => t.type === 'identifier' && t.value.startsWith('"') && /[A-Z]/.test(t.value)).map((t) => t.value);
  if (quotedCamel.length) ctx.add({ id: 'pg-quoted-mixed-case', severity: 'medium', category: 'readability', title: 'Quoted mixed-case identifiers', description: `${Array.from(new Set(quotedCamel)).slice(0, 4).map((x) => `\`${x}\``).join(', ')} must be double-quoted with exactly this casing in every query forever — unquoted references are folded to lowercase and will not match.`, suggestion: 'Name objects in lowercase snake_case so no quoting is ever needed.' });
  else if (unquotedCamel.length) ctx.add({ id: 'pg-case-folding', severity: 'info', category: 'readability', title: 'Mixed-case identifiers are folded to lowercase', description: `PostgreSQL treats \`${Array.from(new Set(unquotedCamel)).slice(0, 4).join('`, `')}\` as \`${Array.from(new Set(unquotedCamel)).slice(0, 4).map((x) => x.toLowerCase()).join('`, `')}\`. Fine, as long as the objects were also created without quotes.` });

  // ---- case-insensitive matching ----
  const lowerConds = a.conditions.filter((c) => c.wrappedColumn === 'LOWER' || c.wrappedColumn === 'UPPER');
  if (lowerConds.length) ctx.amend(`fn-on-column-${lowerConds[0].wrappedColumn}`, { suggestion: `Create an expression index — \`CREATE INDEX ON ${a.tables[0]?.name ?? 'table'} (${lowerConds[0].wrappedColumn!.toLowerCase()}(${lowerConds[0].column?.split('.').pop() ?? 'col'}))\` — or store the column as \`citext\`. For pattern matching, \`ILIKE\` with a \`pg_trgm\` GIN index avoids the function call entirely.` });
  for (const c of a.conditions) if (c.wrappedColumn === 'LOWER' || c.wrappedColumn === 'UPPER') ctx.amend('fn-on-column', { suggestion: `Create an expression index on \`${c.wrappedColumn.toLowerCase()}(${c.column ?? 'col'})\` or use \`citext\`.` });
  if (/\bILIKE\s+'[^%_']/i.test(ctx.sql) && !/pg_trgm/i.test(ctx.sql)) ctx.add({ id: 'pg-ilike-index', severity: 'medium', category: 'performance', title: 'ILIKE cannot use a plain B-tree index', description: 'Even with an anchored pattern (`ILIKE \'abc%\'`), case-insensitive matching bypasses ordinary B-tree indexes.', suggestion: 'Add a trigram index: `CREATE EXTENSION pg_trgm; CREATE INDEX … USING gin (col gin_trgm_ops);` — it accelerates ILIKE, LIKE \'%x%\' and regex matches.' });

  // ---- non-sargable timestamp casts ----
  if (/::\s*date\s*(=|<>|!=)/i.test(code) || /\bDATE_TRUNC\s*\(\s*'(day|month|year|hour|week|quarter)'\s*,\s*[\w."]+\s*\)\s*(=|<>|!=|>=|<=|>|<|IN)/i.test(ctx.sql) || /\bDATE_PART\s*\(\s*'(year|month|day)'\s*,\s*[\w."]+\s*\)\s*=/i.test(ctx.sql) || /\bEXTRACT\s*\(\s*(YEAR|MONTH|DAY)\s+FROM\s+[\w."]+\s*\)\s*=/i.test(code)) ctx.fnIssue(['DATE_TRUNC', 'DATE_PART', 'EXTRACT'], { id: 'pg-cast-in-where', severity: 'high', category: 'performance', title: 'Cast or date_trunc() on a column in WHERE (non-sargable)', description: '`col::date = …`, `date_trunc(\'day\', col) = …` and `extract(year from col) = …` are evaluated for every row; a B-tree on `col` cannot be used.', suggestion: 'Compare the raw column against a half-open range: `col >= \'2024-03-01\' AND col < \'2024-03-02\'`. If the function is unavoidable, create an expression index on it.' });

  // ---- ORDER BY … DESC and NULLs ----
  if (a.orderBy.some((o) => o.dir === 'DESC') && !/\bNULLS\s+(FIRST|LAST)\b/i.test(code) && a.statementType === 'SELECT') ctx.add({ id: 'pg-nulls-desc', severity: 'low', category: 'correctness', title: 'NULLs sort FIRST with ORDER BY … DESC', description: 'PostgreSQL treats NULL as larger than every value, so a descending sort puts NULL rows at the top (the opposite of MySQL/SQLite).', suggestion: 'Add `NULLS LAST` if that is not what you want — and make sure the index is declared with the same NULLS ordering so it can still serve the sort.' });

  // ---- JSON ----
  // `col->>'key'` is parsed as arithmetic by the generic analyzer; report it as what it is
  if (a.conditions.some((c) => c.wrappedColumn === 'ARITHMETIC' && /->>?/.test(c.raw)) && !a.conditions.some((c) => c.wrappedColumn === 'ARITHMETIC' && !/->>?|#>>?/.test(c.raw))) ctx.remove('arith-on-column');
  if (/->>?\s*'[^']+'\s*(=|<>|!=|>|<|LIKE|IN)/i.test(ctx.sql) && (a.statementType === 'SELECT' || a.statementType === 'UPDATE' || a.statementType === 'DELETE')) ctx.add({ id: 'pg-json-filter', severity: 'medium', category: 'performance', title: 'Filtering on a JSON key', description: '`col->>\'key\' = …` cannot use a plain index on `col`.', suggestion: 'Create an expression index `(col->>\'key\')`, or use the containment operator `col @> \'{"key": "v"}\'` with a GIN index on the jsonb column.' });

  // ---- DDL ----
  if (a.statementType === 'CREATE TABLE') {
    if (ctx.columns.some((c) => /^(BIG|SMALL)?SERIAL/.test(c.type))) ctx.add({ id: 'pg-serial', severity: 'low', category: 'readability', title: 'SERIAL is the legacy way to auto-number', description: 'SERIAL creates a loosely-attached sequence with its own permissions and lets clients insert explicit ids that later collide.', suggestion: 'Use `bigint GENERATED ALWAYS AS IDENTITY` (SQL standard, PG 10+).' });
    if (ctx.columns.some((c) => /^TIMESTAMP(\(\d\))?$/.test(c.type)) && !/TIMESTAMPTZ|WITH\s+TIME\s+ZONE/i.test(code)) ctx.add({ id: 'pg-timestamp-tz', severity: 'medium', category: 'correctness', title: 'TIMESTAMP without time zone', description: 'Plain `timestamp` stores the wall-clock value and forgets the zone; comparisons across servers/clients in different zones silently drift.', suggestion: 'Use `timestamptz` (stored as UTC instant, displayed in the session zone) unless you truly need a zone-less local time.' });
    if (ctx.columns.some((c) => /^CHAR\(/.test(c.type) || c.type === 'CHAR')) ctx.add({ id: 'pg-char-n', severity: 'low', category: 'readability', title: 'CHAR(n) pads with spaces', description: 'In PostgreSQL `char(n)` has no performance benefit and its trailing-space semantics surprise everyone (`\'ab\'::char(3) = \'ab \'` is true).', suggestion: 'Use `text` or `varchar(n)`.' });
    if (ctx.columns.some((c) => c.type === 'MONEY')) ctx.add({ id: 'pg-money', severity: 'medium', category: 'correctness', title: 'MONEY type depends on lc_monetary', description: 'Output format and parsing follow the server locale, and it has a fixed 2-decimal scale.', suggestion: 'Use `numeric(12,2)` (or integer minor units).' });
    if (ctx.columns.some((c) => /^(INT|INTEGER|INT4)$/.test(c.type) && c.flags.includes('PK'))) ctx.add({ id: 'pg-int-pk', severity: 'low', category: 'correctness', title: 'INTEGER primary key tops out at ~2.1 billion', description: 'Exhausting an int sequence is a production outage that requires a table rewrite to fix.', suggestion: 'Use `bigint` for surrogate keys — the extra 4 bytes are negligible.' });
    if (ctx.columns.some((c) => /^VARCHAR\(\d+\)$/.test(c.type) && /^VARCHAR\((25[0-5]|\d{4,})\)$/.test(c.type))) ctx.amend('varchar255', { description: 'In PostgreSQL `varchar(n)` and `text` are stored identically; the length is only a CHECK constraint. Pick a meaningful limit or just use `text`.' });
    if (ctx.columns.some((c) => c.flags.includes('FK'))) ctx.amend('fk-index', { severity: 'medium', description: 'PostgreSQL does NOT index foreign-key columns automatically. Every DELETE/UPDATE on the parent scans the child table to check the constraint, and joins on the FK cannot use an index.' });
  }

  // ---- amend generic findings with PostgreSQL specifics ----
  ctx.amend('agg-without-group', { description: (i) => i.description.replace(/Most databases reject this;.*$/, 'PostgreSQL rejects this with `column "…" must appear in the GROUP BY clause or be used in an aggregate function`.') });
  ctx.amend('or-conditions', { suggestion: 'If both columns are indexed, PostgreSQL can combine them with a BitmapOr — check EXPLAIN. Otherwise split into a `UNION ALL` of two indexed queries.' });
  ctx.amend('double-wildcard', { suggestion: 'Add a trigram index (`CREATE EXTENSION pg_trgm; CREATE INDEX … USING gin (col gin_trgm_ops)`) — it makes `LIKE \'%term%\'` index-able. For real search use `tsvector` + GIN.' });
  ctx.amend('leading-wildcard', { suggestion: 'A `pg_trgm` GIN index (`USING gin (col gin_trgm_ops)`) serves `LIKE \'%term%\'` and `ILIKE`; for suffix matches alone, index `reverse(col)` and search `reverse(col) LIKE \'moc.liamg@%\'`.' });
  ctx.amend('scalar-subquery', { suggestion: 'Rewrite as `LEFT JOIN LATERAL (SELECT … WHERE inner.key = outer.key) sub ON true` — LATERAL keeps the per-row intent but lets the planner choose a hash/merge join, or pre-aggregate in a CTE.' });
  ctx.amend('order-random', { suggestion: 'Use `TABLESAMPLE SYSTEM (1)` for an approximate sample, or `WHERE id >= (SELECT floor(random() * max(id)) FROM t) ORDER BY id LIMIT 1`.' });
  ctx.amend('large-offset', { suggestion: 'Use keyset pagination with a row-value comparison (supported natively): `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT n` — it uses the index directly.' });
  ctx.amend('large-in-list', { suggestion: 'Pass one array parameter instead: `WHERE id = ANY($1::bigint[])` — one plan, no parameter-count limits, and the list can come straight from your driver.' });
  ctx.amend('count-distinct', { description: 'Requires de-duplicating all values (a HashAggregate or Sort). PostgreSQL has no built-in approximate distinct count; the `hll` extension or a pre-aggregated materialized view works for dashboards.' });
  ctx.amend('update-join', { description: 'PostgreSQL syntax is `UPDATE target t SET col = s.col FROM source s WHERE s.id = t.id` — the target must NOT be repeated in FROM. Make sure exactly one source row matches each target row.' });
  ctx.amend('delete-batch', { description: 'PostgreSQL has no `DELETE … LIMIT`. Batch with `DELETE FROM t WHERE id IN (SELECT id FROM t WHERE <cond> LIMIT 5000)` in a loop, and remember dead tuples need VACUUM afterwards.' });
  ctx.amend('destructive', { description: 'Double-check the target and environment. PostgreSQL DDL is transactional — wrap it in `BEGIN; … ROLLBACK/COMMIT;` so a mistake can be undone.' });
  ctx.amend('index-locking', { severity: 'medium', title: 'CREATE INDEX blocks writes — use CONCURRENTLY', description: 'A plain `CREATE INDEX` takes a SHARE lock: reads continue, but every INSERT/UPDATE/DELETE on the table waits until the build finishes.', suggestion: 'Use `CREATE INDEX CONCURRENTLY` (cannot run inside a transaction block; check `pg_index.indisvalid` afterwards).' });
  ctx.amend('index-writes', { description: 'INSERT/UPDATE/DELETE must maintain it, and it disables HOT updates for touched columns. Find unused indexes with `pg_stat_user_indexes` (`idx_scan = 0`).' });
  ctx.amend('alter-lock', { description: 'Adding a column with a volatile DEFAULT, changing a type, or adding a NOT NULL without a valid CHECK rewrites or scans the table under an ACCESS EXCLUSIVE lock. Constant defaults are instant (PG 11+). Add constraints as `NOT VALID` and `VALIDATE CONSTRAINT` separately. Set a `lock_timeout`.' });
  ctx.amend('no-pk', { description: 'Without a primary key, logical replication cannot replicate UPDATE/DELETE (`REPLICA IDENTITY`), and there is no efficient way to address a row.' });
  ctx.amend('looks-good', { description: 'The query structure is sound. Verify with `EXPLAIN (ANALYZE, BUFFERS)` that the predicates hit indexes and that estimated vs actual row counts agree.' });
  ctx.amend('in-subquery', { description: 'PostgreSQL turns `IN (SELECT …)` into a semi-join (hash or merge), so it performs as well as EXISTS — no rewrite needed.' });
  ctx.amend('implicit-cast', { description: (i) => i.description + ' PostgreSQL usually casts the literal, so the index still works — but a mismatched parameter type (e.g. a `text` bind for an `int` column) throws `operator does not exist`.' });
}

function rewrite(sql: string) {
  return applyRewrites(sql, [
    { re: new RegExp(String.raw`${COL}\s*::\s*date\s*=\s*'(\d{4}-\d{2}-\d{2})'`, 'gi'), to: (_m, col, d) => dayRange(col, d), note: 'Rewrote `col::date = d` as a half-open range on the raw column so a B-tree index on it can be used.', fixes: 'pg-cast-in-where' },
    { re: new RegExp(String.raw`\bDATE_TRUNC\s*\(\s*'day'\s*,\s*${COL}\s*\)\s*=\s*'(\d{4}-\d{2}-\d{2})'`, 'gi'), to: (_m, col, d) => dayRange(col, d), note: 'Rewrote `date_trunc(\'day\', col) = d` as a half-open range.', fixes: 'pg-cast-in-where' },
    { re: new RegExp(String.raw`\bDATE_TRUNC\s*\(\s*'month'\s*,\s*${COL}\s*\)\s*=\s*'(\d{4}-\d{2})(?:-01)?'`, 'gi'), to: (_m, col, ym) => monthRange(col, ym), note: 'Rewrote `date_trunc(\'month\', col) = m` as a half-open range.', fixes: 'pg-cast-in-where' },
    { re: new RegExp(String.raw`\bDATE_TRUNC\s*\(\s*'year'\s*,\s*${COL}\s*\)\s*=\s*'(\d{4})(?:-01-01)?'`, 'gi'), to: (_m, col, y) => yearRange(col, y), note: 'Rewrote `date_trunc(\'year\', col) = y` as a half-open range.', fixes: 'pg-cast-in-where' },
    { re: new RegExp(String.raw`\bDATE_PART\s*\(\s*'year'\s*,\s*${COL}\s*\)\s*=\s*'?(\d{4})'?`, 'gi'), to: (_m, col, y) => yearRange(col, y), note: 'Rewrote `date_part(\'year\', col) = y` as a half-open range.', fixes: 'pg-cast-in-where' },
    ...extractYearRules('pg-cast-in-where'),
  ]);
}

export const postgres: DialectPack = {
  info: { id: 'postgres', label: 'PostgreSQL', short: 'PG', promptName: 'PostgreSQL', formatter: 'postgresql', description: 'Case folding, timestamptz, pg_trgm, LATERAL, CONCURRENTLY, NULLS ordering' },
  rules,
  rewrite,
  indexDdl: ({ table, name, columns }) => `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} (${columns.join(', ')});`,
  explainTip: 'EXPLAIN (ANALYZE, BUFFERS)',
};
