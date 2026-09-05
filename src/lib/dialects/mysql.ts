import type { DialectPack, RuleContext } from './types';
import { COL, applyRewrites, call, dayRange, monthRange, reportForeignSyntax, yearRange } from './shared';

const ENGINE = 'MySQL';

function rules(ctx: RuleContext): void {
  const { a, code } = ctx;

  // ---- syntax from other engines that MySQL rejects ----
  reportForeignSyntax(ctx, 'my-foreign-syntax', ENGINE, [
    { when: /\[[A-Za-z_][\w ]*\]/, what: 'square-bracket identifiers', use: 'backticks (or nothing)', from: 'SQL Server' },
    { when: /"[A-Za-z_]\w*"\s*(\.|\bAS\b|,|\bFROM\b)/i, what: 'double-quoted identifiers', use: 'backticks — in MySQL `"…"` is a string unless `ANSI_QUOTES` is on', from: 'standard SQL' },
    { when: /\bSELECT\s+(DISTINCT\s+)?TOP\s*\(?\s*\d+/i, what: '`SELECT TOP n`', use: '`LIMIT n`', from: 'SQL Server' },
    { when: /\bFETCH\s+(FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY/i, what: '`FETCH FIRST n ROWS ONLY`', use: '`LIMIT n [OFFSET m]`', from: 'standard SQL' },
    { when: /\bILIKE\b/i, what: '`ILIKE`', use: '`LIKE` — comparisons are already case-insensitive under a `_ci` collation', from: 'PostgreSQL' },
    { when: /::\s*[A-Za-z]/, what: 'the `::type` cast operator', use: '`CAST(expr AS type)`', from: 'PostgreSQL' },
    { when: /\|\|/, what: 'the `||` concatenation operator', use: '`CONCAT()` — by default `||` is logical OR in MySQL (unless `PIPES_AS_CONCAT`)', from: 'standard SQL' },
    { when: call('STRING_AGG', 'ARRAY_AGG', 'LISTAGG'), what: '`STRING_AGG()` / `ARRAY_AGG()`', use: '`GROUP_CONCAT(expr ORDER BY … SEPARATOR \', \')` (or `JSON_ARRAYAGG`)', from: 'PostgreSQL/SQL Server' },
    { when: call('GETDATE', 'SYSDATETIME'), what: '`GETDATE()`', use: '`NOW()` / `CURRENT_TIMESTAMP`', from: 'SQL Server' },
    { when: call('DATE_TRUNC'), what: '`DATE_TRUNC()`', use: '`DATE(col)`, `DATE_FORMAT(col, \'%Y-%m-01\')`, or `LAST_DAY()`', from: 'PostgreSQL' },
    { when: call('DATEPART', 'DATENAME'), what: '`DATEPART()` / `DATENAME()`', use: '`EXTRACT(unit FROM col)` / `YEAR()` / `MONTHNAME()`', from: 'SQL Server' },
    { when: call('LEN'), what: '`LEN()`', use: '`CHAR_LENGTH()` (characters) or `LENGTH()` (bytes)', from: 'SQL Server' },
    { when: call('CHARINDEX', 'STRPOS'), what: '`CHARINDEX()` / `STRPOS()`', use: '`LOCATE()` / `INSTR()`', from: 'SQL Server/PostgreSQL' },
    { when: call('IIF'), what: '`IIF()`', use: '`IF()` or `CASE WHEN … END`', from: 'SQL Server' },
    { when: /(?<![\w.])ISNULL\s*\([^()]*,/i, what: 'two-argument `ISNULL()`', use: '`IFNULL()` / `COALESCE()` — MySQL\'s `ISNULL(x)` takes one argument and returns 0/1', from: 'SQL Server' },
    { when: call('NEWID', 'GEN_RANDOM_UUID'), what: '`NEWID()` / `gen_random_uuid()`', use: '`UUID()` (store as `BINARY(16)` via `UUID_TO_BIN()`)', from: 'SQL Server/PostgreSQL' },
    { when: call('SPLIT_PART'), what: '`SPLIT_PART()`', use: '`SUBSTRING_INDEX()`', from: 'PostgreSQL' },
    { when: call('TO_CHAR', 'TO_DATE', 'TO_TIMESTAMP'), what: '`TO_CHAR()` / `TO_DATE()`', use: '`DATE_FORMAT()` / `STR_TO_DATE()`', from: 'PostgreSQL/Oracle' },
    { when: call('STRFTIME'), what: '`STRFTIME()`', use: '`DATE_FORMAT()`', from: 'SQLite' },
    { when: /\bRETURNING\b/i, what: 'the `RETURNING` clause', use: '`LAST_INSERT_ID()` after the INSERT (MariaDB 10.5+ does support RETURNING)', from: 'PostgreSQL/SQLite' },
    { when: /\bON\s+CONFLICT\b/i, what: '`ON CONFLICT`', use: '`ON DUPLICATE KEY UPDATE col = VALUES(col)` (8.0.19+: `… AS new ON DUPLICATE KEY UPDATE col = new.col`)', from: 'PostgreSQL/SQLite' },
    { when: /\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i, what: '`INSERT OR IGNORE/REPLACE`', use: '`INSERT IGNORE` / `REPLACE INTO`', from: 'SQLite' },
    { when: /\bAUTOINCREMENT\b/i, what: '`AUTOINCREMENT` (one word)', use: '`AUTO_INCREMENT`', from: 'SQLite' },
    { when: /\b(BIG|SMALL)?SERIAL\b/i, what: '`SERIAL`', use: '`BIGINT UNSIGNED AUTO_INCREMENT` (MySQL accepts SERIAL as an alias but it is rarely intended)', from: 'PostgreSQL' },
    { when: /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i, what: '`IDENTITY(1,1)`', use: '`AUTO_INCREMENT`', from: 'SQL Server' },
    { when: /\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i, what: '`GENERATED … AS IDENTITY`', use: '`AUTO_INCREMENT`', from: 'PostgreSQL/SQL Server' },
    { when: /\b(TIMESTAMPTZ|NVARCHAR|NCHAR|UNIQUEIDENTIFIER|DATETIME2|BYTEA|JSONB|UUID|BOOLEAN\s*\(|TEXT\s*\(\s*\d+\s*\))\b/i, what: 'non-MySQL column types (TIMESTAMPTZ/NVARCHAR/JSONB/UUID/BYTEA/…)', use: '`TIMESTAMP` or `DATETIME`, `VARCHAR` with utf8mb4, `JSON`, `BINARY(16)`, `BLOB`', from: 'PostgreSQL/SQL Server' },
    { when: /\bWITH\s*\(\s*NOLOCK\s*\)|\bNOLOCK\b/i, what: '`WITH (NOLOCK)`', use: 'nothing — InnoDB consistent reads do not block; or `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` if you really mean it', from: 'SQL Server' },
    { when: /\bDISTINCT\s+ON\s*\(/i, what: '`DISTINCT ON (…)`', use: '`ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)` in a CTE and filter `rn = 1`', from: 'PostgreSQL' },
    { when: /\bFULL\s+(OUTER\s+)?JOIN\b/i, what: '`FULL OUTER JOIN`', use: 'a `LEFT JOIN … UNION ALL … RIGHT JOIN … WHERE left.id IS NULL`', from: 'standard SQL' },
    { when: /\bLATERAL\b/i, what: '`LATERAL`', use: 'MySQL 8.0.14+ supports LATERAL derived tables; older versions need a correlated subquery or a rewrite', from: 'PostgreSQL' },
    { when: /\bEXCEPT\b/i, what: '`EXCEPT`', use: 'MySQL 8.0.31+ supports EXCEPT/INTERSECT; on older versions use `NOT EXISTS` / `LEFT JOIN … IS NULL`', from: 'standard SQL' },
    { when: /\bINTERSECT\b/i, what: '`INTERSECT`', use: 'MySQL 8.0.31+ only; otherwise `INNER JOIN` or `EXISTS`', from: 'standard SQL' },
    { when: /\bCREATE\s+INDEX\s+CONCURRENTLY\b/i, what: '`CREATE INDEX CONCURRENTLY`', use: '`ALTER TABLE … ADD INDEX …, ALGORITHM=INPLACE, LOCK=NONE` (InnoDB builds online by default)', from: 'PostgreSQL' },
    { when: /\bUSING\s+(GIN|GIST|BRIN|SPGIST)\b/i, what: 'GIN/GiST/BRIN index methods', use: '`FULLTEXT` or `SPATIAL` indexes, or a functional index on a generated column', from: 'PostgreSQL' },
    { when: /\bDECLARE\s+@\w+/i, what: '`DECLARE @var`', use: '`SET @var = …` (session variables need no declaration)', from: 'SQL Server' },
    { when: /\$\d+\b/, what: '`$1`-style positional parameters', use: '`?` placeholders', from: 'PostgreSQL' },
    { when: /~\*?\s*'/, what: 'the `~` regex operator', use: '`REGEXP` / `RLIKE` / `REGEXP_LIKE()`', from: 'PostgreSQL' },
  ]);

  // ---- ONLY_FULL_GROUP_BY ----
  if (a.groupBy.length && a.statementType === 'SELECT' && !a.selectStar) {
    const groupSet = new Set(a.groupBy.map((g) => g.split('.').pop()!.toLowerCase()));
    const aggRe = /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|JSON_ARRAYAGG|JSON_OBJECTAGG|STD|STDDEV|VARIANCE|BIT_AND|BIT_OR|ANY_VALUE)\s*\(/i;
    const bare = a.selectColumns.filter((c) => !aggRe.test(c) && !/\bOVER\s*\(/i.test(c) && /^[\w.`]+(\s+AS\s+\S+)?$/i.test(c.trim())).map((c) => c.replace(/\s+AS\s+\S+$/i, '').trim()).filter((c) => !groupSet.has(c.replace(/`/g, '').split('.').pop()!.toLowerCase()));
    if (bare.length) ctx.add({ id: 'my-only-full-group-by', severity: 'high', category: 'correctness', title: 'Non-aggregated columns not in GROUP BY', description: `\`${bare.slice(0, 4).join('`, `')}\` ${bare.length > 1 ? 'are' : 'is'} neither grouped nor aggregated. With the default \`ONLY_FULL_GROUP_BY\` mode (MySQL 5.7+) this is error 1055; with it off MySQL returns an *arbitrary* row's value.`, suggestion: 'Add the columns to GROUP BY, wrap them in an aggregate, or use `ANY_VALUE(col)` when you know they are functionally dependent on the group key.' });
  }
  if (a.selectStar && a.groupBy.length) ctx.add({ id: 'my-star-group-by', severity: 'high', category: 'correctness', title: 'SELECT * with GROUP BY', description: 'Every column that is not in the GROUP BY list violates `ONLY_FULL_GROUP_BY` (error 1055) unless it is functionally dependent on a grouped primary key.', suggestion: 'List the columns explicitly.' });

  // ---- MySQL-specific non-sargable patterns ----
  for (const fn of ['DATE', 'YEAR', 'MONTH']) ctx.amend(`fn-on-column-${fn}`, { suggestion: 'Compare the raw column against a half-open range instead: `col >= \'2024-03-01\' AND col < \'2024-04-01\'`. MySQL 8.0.13+ can also index a functional key part `((DATE(col)))`, but the range is simpler and reusable.' });
  if (/\bDATE_FORMAT\s*\(\s*[\w.`]+\s*,\s*'[^']*'\s*\)\s*(=|<>|!=|LIKE|IN)/i.test(ctx.sql)) ctx.fnIssue(['DATE_FORMAT'], { id: 'my-date-format-where', severity: 'high', category: 'performance', title: 'DATE_FORMAT() on a column in WHERE (non-sargable)', description: 'The function runs for every row and the result is a string, so no index on the column can be used and comparisons are lexicographic.', suggestion: 'Compare the raw date column against a range (`col >= \'2024-03-01\' AND col < \'2024-04-01\'`).' });

  // ---- collation / charset ----
  if (/\bCOLLATE\s+utf8mb4_bin\b/i.test(code) || /\bBINARY\s+[\w.`]+\s*(=|LIKE)/i.test(code)) ctx.add({ id: 'my-binary-compare', severity: 'medium', category: 'performance', title: 'BINARY / COLLATE applied in a comparison', description: 'Changing the collation inside a predicate is a function on the column: the index (built with the column\'s own collation) cannot be used.', suggestion: 'Declare the column with the collation you need (`VARCHAR(…) COLLATE utf8mb4_bin`) so the index matches the comparison.' });
  const joinConds = a.tables.map((t) => t.condition ?? '').join(' ');
  if (a.tables.length > 1 && /\bCONVERT\s*\(|\bCOLLATE\b/i.test(joinConds)) ctx.add({ id: 'my-join-collation', severity: 'high', category: 'performance', title: 'Collation conversion inside a JOIN condition', description: 'Joining columns with different character sets/collations forces a conversion per row and disables index use on one side — a classic cause of "Illegal mix of collations" workarounds.', suggestion: 'Align both columns to the same charset/collation (`ALTER TABLE … CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`).' });

  // ---- implicit conversion: string column vs number ----
  for (const c of a.conditions) {
    if (c.column && c.op === '=' && c.value && /^\d+$/.test(c.value) && /(^|[._])(phone|mobile|zip|postcode|postal_code|code|sku|account_no|iban|card_number|number)$/i.test(c.column)) {
      ctx.add({ id: 'my-string-vs-number', severity: 'high', category: 'performance', title: `\`${c.column}\` compared to a number`, description: `If \`${c.column}\` is a VARCHAR, MySQL converts *every row's value* to DOUBLE to compare it — a full scan regardless of indexes, and \`'123abc' = 123\` is true.`, suggestion: `Quote the value: \`${c.column} = '${c.value}'\`.` });
      break;
    }
  }

  // ---- pagination ----
  if (a.limit && a.offset) ctx.amend('large-offset', { suggestion: 'Use keyset pagination: `WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT n`. If you must keep OFFSET, do a deferred join: `SELECT t.* FROM t JOIN (SELECT id FROM t ORDER BY created_at LIMIT 20 OFFSET 5000) x USING (id)` — the offset then only scans the covering index.' });

  // ---- InnoDB / storage engine ----
  if (a.statementType === 'CREATE TABLE') {
    if (/\bENGINE\s*=\s*MyISAM\b/i.test(code)) ctx.add({ id: 'my-myisam', severity: 'high', category: 'safety', title: 'MyISAM storage engine', description: 'No transactions, no foreign keys, no crash recovery, table-level locks. Removed as default in 5.5 and not supported for system tables in 8.0.', suggestion: 'Use `ENGINE=InnoDB` (the default).' });
    if (/\bCHARSET\s*=\s*utf8\b(?!mb4)|\bCHARACTER\s+SET\s+utf8\b(?!mb4)/i.test(code)) ctx.add({ id: 'my-utf8mb3', severity: 'high', category: 'correctness', title: '`utf8` is 3-byte utf8mb3, not real UTF-8', description: 'Emoji and many CJK characters need 4 bytes and fail with "Incorrect string value". `utf8` is deprecated.', suggestion: 'Use `CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci` (MySQL 8) or `utf8mb4_unicode_ci`.' });
    if (ctx.columns.some((c) => /^ENUM\(/.test(c.type))) ctx.add({ id: 'my-enum', severity: 'low', category: 'readability', title: 'ENUM column', description: 'Adding a value later requires an ALTER TABLE, invalid values silently become \'\' in non-strict mode, and sorting is by enumeration index rather than label.', suggestion: 'Consider a lookup table with a foreign key, or a short VARCHAR with a CHECK constraint (enforced since 8.0.16).' });
    if (ctx.columns.some((c) => /^TIMESTAMP/.test(c.type))) ctx.add({ id: 'my-timestamp-2038', severity: 'medium', category: 'correctness', title: 'TIMESTAMP is limited to 1970–2038', description: 'MySQL `TIMESTAMP` is a 32-bit epoch (UTC-converted). Dates after 2038-01-19 cannot be stored; before 8.0.2 the first TIMESTAMP column also silently got `ON UPDATE CURRENT_TIMESTAMP`.', suggestion: 'Use `DATETIME(6)` with an explicit `DEFAULT CURRENT_TIMESTAMP` and store UTC — unless you specifically want session-time-zone conversion.' });
    if (ctx.columns.some((c) => /^(VARCHAR\((3[6-9]|[4-9]\d)\)|CHAR\(36\))$/.test(c.type) && /(^|_)(uuid|guid)$/i.test(c.name))) ctx.add({ id: 'my-uuid-varchar', severity: 'medium', category: 'performance', title: 'UUID stored as CHAR(36)/VARCHAR', description: 'Random UUIDs as a clustered primary key cause page splits on every insert, and 36-byte keys are copied into every secondary index.', suggestion: 'Store as `BINARY(16)` via `UUID_TO_BIN(uuid, 1)` (swaps the time bits to be roughly sequential), or keep an `AUTO_INCREMENT` PK and index the UUID separately.' });
    if (ctx.columns.some((c) => /^(TEXT|MEDIUMTEXT|LONGTEXT|BLOB)/.test(c.type) && c.flags.includes('DEFAULT'))) ctx.add({ id: 'my-text-default', severity: 'medium', category: 'correctness', title: 'DEFAULT on a TEXT/BLOB column', description: 'MySQL < 8.0.13 rejects literal defaults on TEXT/BLOB (`BLOB, TEXT, GEOMETRY or JSON column can\'t have a default value`); 8.0.13+ needs the expression form `DEFAULT (\'…\')`.' });
    if (ctx.columns.some((c) => /^INT\(\d+\)|^TINYINT\((?!1\))\d+\)|^BIGINT\(\d+\)/.test(c.type))) ctx.add({ id: 'my-int-width', severity: 'low', category: 'readability', title: 'Display width on integer types (INT(11))', description: 'The number in `INT(11)` is only a padding hint for `ZEROFILL` — it does not limit the range. Deprecated in 8.0.17.', suggestion: 'Write `INT` / `BIGINT` (and `UNSIGNED` if negatives are impossible).' });
    ctx.amend('fk-index', { severity: 'info', title: 'InnoDB indexes foreign keys automatically', description: 'InnoDB creates an index on each declared FOREIGN KEY column if one does not already exist, so no action is needed — but the FK must be declared for that to happen.' });
    ctx.amend('no-pk', { severity: 'high', description: 'InnoDB is a clustered index: without a PRIMARY KEY it uses the first UNIQUE NOT NULL index or a hidden 6-byte row id, which hurts secondary-index size and row-based replication (`sql_require_primary_key` blocks it entirely).' });
  }

  // ---- amend generic findings ----
  ctx.amend('agg-without-group', { description: (i) => i.description.replace(/Most databases reject this;.*$/, 'With `ONLY_FULL_GROUP_BY` (default since 5.7) MySQL raises error 1055; with it disabled it returns a value from an arbitrary row.') });
  ctx.amend('or-conditions', { suggestion: 'MySQL can use an `index_merge union` if every branch is covered by an index — check `EXPLAIN` for `Using union(...)`. Otherwise rewrite as `UNION ALL` of two indexed queries.' });
  ctx.amend('double-wildcard', { suggestion: 'Add a `FULLTEXT` index and use `MATCH(col) AGAINST(\'term\' IN BOOLEAN MODE)` — InnoDB supports it since 5.6. For prefix-only matching keep `LIKE \'term%\'`.' });
  ctx.amend('leading-wildcard', { suggestion: 'Use a `FULLTEXT` index with `MATCH … AGAINST`, or store a reversed copy (generated column `REVERSE(col)`) to turn suffix matches into prefix matches.' });
  ctx.amend('scalar-subquery', { suggestion: 'MySQL executes a correlated scalar subquery once per outer row (DEPENDENT SUBQUERY in EXPLAIN). Pre-aggregate in a derived table / CTE (8.0+) and `LEFT JOIN` it.' });
  ctx.amend('not-in-subquery', { description: (i) => i.description + ' MySQL < 8.0 also could not convert `NOT IN (subquery)` to an anti-join, re-running the subquery per row.' });
  ctx.amend('in-subquery', { description: 'MySQL 5.6+ converts most `IN (SELECT …)` predicates to a semi-join (look for `FirstMatch`/`LooseScan`/`Materialize` in EXPLAIN). Correlated subqueries with `ORDER BY`/`LIMIT` inside are still re-executed per row.' });
  ctx.amend('order-random', { suggestion: '`ORDER BY RAND()` materialises the whole table into a temp table. Pick a random id instead: `WHERE id >= FLOOR(RAND() * (SELECT MAX(id) FROM t)) ORDER BY id LIMIT 1`.' });
  ctx.amend('count-distinct', { description: 'Requires a temporary table to de-duplicate. MySQL has no approximate distinct; for dashboards maintain a summary table or use `HyperLogLog` in the application layer.' });
  ctx.amend('update-join', { description: 'MySQL syntax is `UPDATE a JOIN b ON … SET a.col = b.col WHERE …`. Note that `ORDER BY`/`LIMIT` are not allowed in multi-table UPDATE, and the target may not be selected from in a subquery of the same statement (error 1093).' });
  ctx.amend('delete-batch', { description: 'MySQL supports `DELETE … ORDER BY id LIMIT 5000` — loop until 0 rows affected, sleeping briefly between batches so replicas keep up and the undo log stays small.' });
  ctx.amend('destructive', { description: 'Double-check target and environment: MySQL DDL causes an implicit COMMIT and cannot be rolled back. `DROP TABLE` also removes it from replicas.' });
  ctx.amend('index-locking', { severity: 'info', title: 'InnoDB builds most indexes online', description: '`CREATE INDEX` on InnoDB (5.6+) is `ALGORITHM=INPLACE, LOCK=NONE` by default — DML continues. FULLTEXT and SPATIAL indexes, and tables with a very large row count, may still cause a brief metadata lock at the end. Be explicit so it fails loudly instead of locking: `ALTER TABLE t ADD INDEX …, ALGORITHM=INPLACE, LOCK=NONE`.' });
  ctx.amend('index-writes', { description: 'INSERT/UPDATE/DELETE must maintain it, and every secondary index stores a copy of the primary key. Find unused ones with `sys.schema_unused_indexes`.' });
  ctx.amend('alter-lock', { description: 'Many ALTERs are online in InnoDB (`ALGORITHM=INPLACE`), but changing a column type, charset, or adding a column to a partitioned table can rebuild the table (`ALGORITHM=COPY`) under a lock. Specify `ALGORITHM=INSTANT`/`INPLACE, LOCK=NONE` so it errors rather than locking, or use gh-ost / pt-online-schema-change.' });
  ctx.amend('looks-good', { description: 'The query structure is sound. Verify with `EXPLAIN FORMAT=TREE` (8.0.16+) or `EXPLAIN ANALYZE` (8.0.18+) that the predicates hit indexes and no `Using filesort` / `Using temporary` appears.' });
  ctx.amend('limit-no-order', { description: 'Without ORDER BY, InnoDB returns rows in whatever index the optimizer picked — usually primary-key order, but that changes with the plan.' });
  ctx.amend('large-in-list', { suggestion: 'Load the ids into a temporary table (or a `JSON_TABLE()` on 8.0+) and JOIN — the optimizer estimates range scans better than a giant IN list (`eq_range_index_dive_limit`, default 200).' });
  ctx.amend('implicit-cast', { description: (i) => i.description + ' In MySQL, comparing a number column to a string works (the string is cast once), but the reverse — a VARCHAR column vs a numeric literal — casts every row and cannot use the index.' });
  ctx.amend('order-not-selected', { severity: 'info', description: 'MySQL allows ordering by a column that is not in the SELECT DISTINCT list (with ONLY_FULL_GROUP_BY it must be functionally dependent) — but the result order then depends on which duplicate survives, so it is not portable or stable.' });
  ctx.amend('varchar255', { description: 'In MySQL the declared length matters: temporary tables and sorts allocate the full width in memory (utf8mb4 × 255 = 1020 bytes per value). Size columns realistically.' });
}

function rewrite(sql: string) {
  return applyRewrites(sql, [
    { re: new RegExp(String.raw`\bDATE_FORMAT\s*\(\s*${COL}\s*,\s*'%Y-%m'\s*\)\s*=\s*'(\d{4}-\d{2})'`, 'gi'), to: (_m, col, ym) => monthRange(col, ym), note: 'Rewrote `DATE_FORMAT(col, \'%Y-%m\') = m` as a sargable half-open range.', fixes: 'my-date-format-where' },
    { re: new RegExp(String.raw`\bDATE_FORMAT\s*\(\s*${COL}\s*,\s*'%Y-%m-%d'\s*\)\s*=\s*'(\d{4}-\d{2}-\d{2})'`, 'gi'), to: (_m, col, d) => dayRange(col, d), note: 'Rewrote `DATE_FORMAT(col, \'%Y-%m-%d\') = d` as a half-open range.', fixes: 'my-date-format-where' },
    { re: new RegExp(String.raw`\bDATE_FORMAT\s*\(\s*${COL}\s*,\s*'%Y'\s*\)\s*=\s*'(\d{4})'`, 'gi'), to: (_m, col, y) => yearRange(col, y), note: 'Rewrote `DATE_FORMAT(col, \'%Y\') = y` as a half-open range.', fixes: 'my-date-format-where' },
    { re: new RegExp(String.raw`\bMONTH\s*\(\s*${COL}\s*\)\s*=\s*(\d{1,2})\s+AND\s+YEAR\s*\(\s*\1\s*\)\s*=\s*(\d{4})`, 'gi'), to: (_m, col, mo, y) => monthRange(col, `${y}-${String(mo).padStart(2, '0')}`), note: 'Rewrote `MONTH(col) = m AND YEAR(col) = y` as a single sargable range.', fixes: ['fn-on-column-MONTH', 'fn-on-column-YEAR'] },
    { re: new RegExp(String.raw`\bYEAR\s*\(\s*${COL}\s*\)\s*=\s*(\d{4})\s+AND\s+MONTH\s*\(\s*\1\s*\)\s*=\s*(\d{1,2})`, 'gi'), to: (_m, col, y, mo) => monthRange(col, `${y}-${String(mo).padStart(2, '0')}`), note: 'Rewrote `YEAR(col) = y AND MONTH(col) = m` as a single sargable range.', fixes: ['fn-on-column-MONTH', 'fn-on-column-YEAR'] },
  ]);
}

export const mysql: DialectPack = {
  info: { id: 'mysql', label: 'MySQL', short: 'MY', promptName: 'MySQL', formatter: 'mysql', description: 'ONLY_FULL_GROUP_BY, utf8mb4, InnoDB clustering, index_merge, TIMESTAMP 2038' },
  rules,
  rewrite,
  indexDdl: ({ table, name, columns }) => `ALTER TABLE ${table} ADD INDEX ${name} (${columns.join(', ')}), ALGORITHM=INPLACE, LOCK=NONE;`,
  explainTip: 'EXPLAIN ANALYZE (8.0.18+) or EXPLAIN FORMAT=TREE',
};
