import type { DialectPack, RuleContext } from './types';
import { ARGS, COL, applyRewrites, call, dayRange, monthRange, reportForeignSyntax, yearRange } from './shared';

const ENGINE = 'SQL Server';

function rules(ctx: RuleContext): void {
  const { a, code } = ctx;

  // ---- syntax from other engines that T-SQL rejects ----
  reportForeignSyntax(ctx, 'ms-foreign-syntax', ENGINE, [
    { when: /`[^`]+`/, what: 'backtick-quoted identifiers', use: 'square brackets `[name]` or double quotes', from: 'MySQL' },
    { when: /\bLIMIT\s+\d+(\s*,\s*\d+)?/i, what: '`LIMIT`', use: '`SELECT TOP (n)` or `ORDER BY … OFFSET m ROWS FETCH NEXT n ROWS ONLY` (2012+)', from: 'MySQL/PostgreSQL' },
    { when: /\bOFFSET\s+\d+\s*(?!ROWS?)\b(?!\s+ROW)/i, what: '`OFFSET n` without `ROWS`', use: '`OFFSET n ROWS FETCH NEXT m ROWS ONLY` — and it requires ORDER BY', from: 'PostgreSQL' },
    { when: /\bILIKE\b/i, what: '`ILIKE`', use: '`LIKE` — the default collations are already case-insensitive (`_CI_`)', from: 'PostgreSQL' },
    { when: /::\s*[A-Za-z]/, what: 'the `::type` cast operator', use: '`CAST(expr AS type)` or `TRY_CAST()`', from: 'PostgreSQL' },
    { when: /\|\|/, what: 'the `||` concatenation operator', use: '`+` or `CONCAT()` (which also handles NULLs as empty strings)', from: 'standard SQL' },
    { when: call('IFNULL', 'NVL'), what: '`IFNULL()` / `NVL()`', use: '`ISNULL()` or `COALESCE()`', from: 'MySQL/Oracle' },
    { when: call('NOW', 'CURRENT_DATE'), what: '`NOW()` / `CURRENT_DATE`', use: '`GETDATE()`, `SYSDATETIME()`, `SYSUTCDATETIME()`, or `CAST(GETDATE() AS date)`', from: 'MySQL/PostgreSQL' },
    { when: call('GROUP_CONCAT', 'ARRAY_AGG', 'LISTAGG'), what: '`GROUP_CONCAT()` / `ARRAY_AGG()`', use: '`STRING_AGG(expr, sep) WITHIN GROUP (ORDER BY …)` (2017+) or `FOR XML PATH` on older versions', from: 'MySQL/PostgreSQL' },
    { when: call('LENGTH', 'CHAR_LENGTH'), what: '`LENGTH()` / `CHAR_LENGTH()`', use: '`LEN()` (ignores trailing spaces) or `DATALENGTH()` (bytes)', from: 'MySQL/PostgreSQL' },
    { when: call('LOCATE', 'INSTR', 'STRPOS', 'POSITION'), what: '`LOCATE()` / `INSTR()` / `POSITION()`', use: '`CHARINDEX(sub, str)`', from: 'MySQL/PostgreSQL' },
    { when: call('SUBSTR'), what: '`SUBSTR()`', use: '`SUBSTRING(str, start, length)` — the length argument is mandatory', from: 'MySQL/SQLite/Oracle' },
    { when: /(?<![\w.])IF\s*\(/i, what: 'the `IF()` function', use: '`IIF()` or `CASE WHEN … END`', from: 'MySQL' },
    { when: call('DATE_TRUNC'), what: '`DATE_TRUNC()`', use: '`DATETRUNC(unit, col)` (2022+) or `DATEADD(dd, DATEDIFF(dd, 0, col), 0)`', from: 'PostgreSQL' },
    { when: call('DATE_FORMAT', 'TO_CHAR', 'STRFTIME'), what: '`DATE_FORMAT()` / `TO_CHAR()` / `STRFTIME()`', use: '`FORMAT(col, \'yyyy-MM-dd\')` (slow, CLR) or `CONVERT(varchar, col, 23)`', from: 'MySQL/PostgreSQL/SQLite' },
    { when: call('STR_TO_DATE', 'TO_DATE'), what: '`STR_TO_DATE()` / `TO_DATE()`', use: '`TRY_CONVERT(date, str, style)` or `PARSE()`', from: 'MySQL/PostgreSQL' },
    { when: call('DATE_ADD', 'DATE_SUB', 'ADDDATE', 'SUBDATE'), what: '`DATE_ADD()` / `DATE_SUB()`', use: '`DATEADD(unit, n, col)`', from: 'MySQL' },
    { when: /\bINTERVAL\s+'?\d+'?\s+(DAY|MONTH|YEAR|HOUR|MINUTE|SECOND)S?\b/i, what: '`INTERVAL n unit` arithmetic', use: '`DATEADD(day, n, col)`', from: 'MySQL/PostgreSQL' },
    { when: call('EXTRACT'), what: '`EXTRACT(unit FROM col)`', use: '`DATEPART(unit, col)` / `YEAR()` / `MONTH()` / `DAY()`', from: 'standard SQL' },
    { when: call('UUID', 'GEN_RANDOM_UUID'), what: '`UUID()` / `gen_random_uuid()`', use: '`NEWID()` (or `NEWSEQUENTIALID()` as a column default)', from: 'MySQL/PostgreSQL' },
    { when: call('RANDOM'), what: '`RANDOM()`', use: '`RAND()` (once per query) or `NEWID()` / `CRYPT_GEN_RANDOM()` (per row)', from: 'PostgreSQL/SQLite' },
    { when: call('REGEXP_LIKE', 'REGEXP_REPLACE') , what: 'regex functions', use: '`LIKE` with `[a-z]` character classes, `PATINDEX()`, or a CLR function — SQL Server has no regex (until 2025 preview)', from: 'MySQL/PostgreSQL' },
    { when: /\bREGEXP\b|\bRLIKE\b|~\*?\s*'/i, what: '`REGEXP` / `~` regex operators', use: '`LIKE` with character classes or `PATINDEX()`', from: 'MySQL/PostgreSQL' },
    { when: /\bRETURNING\b/i, what: 'the `RETURNING` clause', use: '`OUTPUT INSERTED.col` placed *before* VALUES / after SET', from: 'PostgreSQL/SQLite' },
    { when: /\bON\s+CONFLICT\b|\bON\s+DUPLICATE\s+KEY\b/i, what: '`ON CONFLICT` / `ON DUPLICATE KEY`', use: '`MERGE … WHEN MATCHED THEN UPDATE WHEN NOT MATCHED THEN INSERT` (add `WITH (HOLDLOCK)`), or an `UPDATE` followed by `INSERT … WHERE NOT EXISTS` in a transaction', from: 'PostgreSQL/MySQL' },
    { when: /\bINSERT\s+(OR\s+)?(IGNORE|REPLACE)\b|\bREPLACE\s+INTO\b/i, what: '`INSERT IGNORE` / `REPLACE INTO`', use: '`MERGE` or `IF NOT EXISTS` guards', from: 'MySQL/SQLite' },
    { when: /\bAUTO_?INCREMENT\b/i, what: '`AUTO_INCREMENT`', use: '`IDENTITY(1,1)`', from: 'MySQL/SQLite' },
    { when: /\b(BIG|SMALL)?SERIAL\b/i, what: '`SERIAL`', use: '`INT IDENTITY(1,1)` / `BIGINT IDENTITY(1,1)`', from: 'PostgreSQL' },
    { when: /\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i, what: '`GENERATED … AS IDENTITY`', use: '`IDENTITY(1,1)`', from: 'PostgreSQL' },
    { when: /\b(BOOLEAN|BOOL|TEXT|MEDIUMTEXT|LONGTEXT|BLOB|TIMESTAMPTZ|JSONB|JSON|UUID|SERIAL|DOUBLE(\s+PRECISION)?|UNSIGNED|TINYINT\s*\(\s*1\s*\)|BYTEA|AUTOINCREMENT)\b/i, what: 'non-T-SQL column types (BOOLEAN/TEXT/BLOB/JSON/UUID/DOUBLE/UNSIGNED)', use: '`BIT`, `NVARCHAR(MAX)`, `VARBINARY(MAX)`, `NVARCHAR(MAX)` + `ISJSON()`, `UNIQUEIDENTIFIER`, `FLOAT`, a CHECK for unsigned', from: 'MySQL/PostgreSQL/SQLite' },
    { when: /\bTRUE\b|\bFALSE\b/i, what: '`TRUE` / `FALSE` literals', use: '`1` / `0` — SQL Server has no boolean literal (`BIT` columns hold 0/1)', from: 'MySQL/PostgreSQL' },
    { when: /\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b/i, what: '`IS DISTINCT FROM`', use: 'supported only in SQL Server 2022+; older versions need `(a = b OR (a IS NULL AND b IS NULL))`', from: 'PostgreSQL' },
    { when: /\bDISTINCT\s+ON\s*\(/i, what: '`DISTINCT ON (…)`', use: '`ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)` in a CTE and filter `rn = 1`', from: 'PostgreSQL' },
    { when: /\bLATERAL\b/i, what: '`LATERAL`', use: '`CROSS APPLY` / `OUTER APPLY`', from: 'PostgreSQL/MySQL' },
    { when: /\bNULLS\s+(FIRST|LAST)\b/i, what: '`NULLS FIRST/LAST`', use: 'an expression key: `ORDER BY CASE WHEN col IS NULL THEN 1 ELSE 0 END, col` — NULLs always sort first ascending in SQL Server', from: 'PostgreSQL/SQLite' },
    { when: /\bCREATE\s+INDEX\s+CONCURRENTLY\b/i, what: '`CREATE INDEX CONCURRENTLY`', use: '`CREATE INDEX … WITH (ONLINE = ON)` (Enterprise / Azure SQL)', from: 'PostgreSQL' },
    { when: /\bCREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\b/i, what: '`CREATE INDEX IF NOT EXISTS`', use: '`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = \'…\') CREATE INDEX …`', from: 'PostgreSQL/SQLite/MySQL' },
    { when: /\bUSING\s+(GIN|GIST|BRIN|HASH|BTREE)\b/i, what: '`USING gin/gist/hash` index methods', use: 'clustered/nonclustered rowstore, `COLUMNSTORE`, or `FULLTEXT` indexes', from: 'PostgreSQL/MySQL' },
    { when: /\b(USE|FORCE|IGNORE)\s+INDEX\s*\(|\bSTRAIGHT_JOIN\b/i, what: 'MySQL index hints', use: '`WITH (INDEX(name))` table hints or `OPTION (FORCE ORDER)` — sparingly', from: 'MySQL' },
    { when: (c) => /\bSET\s+@\w+\s*(=|:=)/i.test(c.code) && !/\bDECLARE\s+@/i.test(c.code), what: '`SET @var = …` without DECLARE', use: '`DECLARE @var type = …;` — T-SQL variables must be declared with a type', from: 'MySQL' },
    { when: /\bPRAGMA\b/i, what: '`PRAGMA`', use: '`SET` options or `ALTER DATABASE … SET …`', from: 'SQLite' },
    { when: /\$\d+\b|\?(?=\s*[,)]|\s*$|\s+(AND|OR)\b)/i, what: '`$1` / `?` placeholders', use: 'named `@parameters` (`sp_executesql` style)', from: 'PostgreSQL/JDBC' },
    { when: /\bCAST\s*\([^()]+\s+AS\s+(TEXT|SIGNED|UNSIGNED|INTEGER)\s*\)/i, what: '`CAST(x AS TEXT/SIGNED/UNSIGNED)`', use: '`CAST(x AS NVARCHAR(MAX))` / `CAST(x AS INT)` / `CAST(x AS BIGINT)`', from: 'MySQL/SQLite' },
    { when: /\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i, what: '`CREATE TABLE IF NOT EXISTS`', use: '`IF OBJECT_ID(\'dbo.t\', \'U\') IS NULL CREATE TABLE …` (only `DROP … IF EXISTS` is supported, 2016+)', from: 'MySQL/PostgreSQL/SQLite' },
  ]);

  // ---- NOLOCK ----
  if (/\bNOLOCK\b|\bREAD\s*UNCOMMITTED\b/i.test(code)) ctx.add({ id: 'ms-nolock', severity: 'high', category: 'correctness', title: 'NOLOCK / READ UNCOMMITTED reads dirty data', description: 'Besides seeing uncommitted rows, allocation-order scans under NOLOCK can read the same row twice or skip rows during page splits, and the query can fail with error 601 ("could not continue scan"). It is not a "go faster" switch.', suggestion: 'Enable `READ_COMMITTED_SNAPSHOT` on the database (readers no longer block writers), or use `SNAPSHOT` isolation for reports.' });

  // ---- TOP without ORDER BY (generic rule fires only for LIMIT) ----
  if (/\bSELECT\s+(DISTINCT\s+)?TOP\b/i.test(code) && !a.orderBy.length && a.tables.length && !ctx.has('limit-no-order')) ctx.add({ id: 'ms-top-no-order', severity: 'medium', category: 'correctness', title: 'TOP without ORDER BY is non-deterministic', description: 'The rows returned depend on the chosen access path (heap order, index used, parallelism) and change between executions.', suggestion: 'Add `ORDER BY <unique key>`; for pagination use `OFFSET … ROWS FETCH NEXT … ROWS ONLY`.' });
  ctx.amend('limit-no-order', { title: 'TOP/OFFSET without ORDER BY is non-deterministic' });

  // ---- SELECT INTO / temp tables ----
  if (/\bINTO\s+#\w+/i.test(code)) ctx.add({ id: 'ms-select-into-temp', severity: 'info', category: 'performance', title: 'SELECT … INTO #temp', description: 'Creates the temp table with inferred types and no indexes/statistics; the heap is fine for small sets but large intermediate results benefit from an explicit `CREATE TABLE #t (…)` with a clustered index.' });

  // ---- non-sargable: ISNULL / COALESCE / CONVERT / DATEADD / DATEDIFF on columns ----
  if (/(?<![\w.])(ISNULL|COALESCE)\s*\(\s*[\w.\[\]]+\s*,[^()]*\)\s*(=|<>|!=|>|<|>=|<=|LIKE|IN)/i.test(code)) ctx.fnIssue(['ISNULL', 'COALESCE'], { id: 'ms-isnull-where', severity: 'high', category: 'performance', title: 'ISNULL()/COALESCE() around a column in WHERE (non-sargable)', description: 'Wrapping the column disables index seeks — every row is evaluated. `ISNULL(col, 0) = 0` is a very common pattern that silently scans.', suggestion: 'Write `(col = 0 OR col IS NULL)` so each branch can seek, or make the column NOT NULL with a default.' });
  if (/(?<![\w.])CONVERT\s*\(\s*(VARCHAR|NVARCHAR|CHAR|DATE)\b[^()]*,\s*[\w.\[\]]+\s*(,\s*\d+\s*)?\)\s*(=|<>|!=|>|<|>=|<=|LIKE)/i.test(code) || /(?<![\w.])CAST\s*\(\s*[\w.\[\]]+\s+AS\s+(DATE|VARCHAR|NVARCHAR|CHAR)\b[^()]*\)\s*(=|<>|!=|>|<|>=|<=|LIKE)/i.test(code)) ctx.fnIssue(['CONVERT', 'CAST'], { id: 'ms-convert-where', severity: 'high', category: 'performance', title: 'CONVERT()/CAST() on a column in WHERE (non-sargable)', description: 'Converting the column (e.g. `CONVERT(varchar, dt, 112) = \'20240301\'`) prevents an index seek. `CAST(col AS date) = @d` is the one exception SQL Server can seek (it internally builds a range); all other conversions are not sargable.', suggestion: 'Compare the raw column to a range: `dt >= \'20240301\' AND dt < \'20240302\'`.' });
  if (/(?<![\w.])DATEADD\s*\(\s*\w+\s*,\s*-?\d+\s*,\s*[\w.\[\]]+\s*\)\s*(=|<>|!=|>|<|>=|<=)/i.test(code)) ctx.fnIssue(['DATEADD'], { id: 'ms-dateadd-column', severity: 'high', category: 'performance', title: 'DATEADD() applied to the column (non-sargable)', description: '`DATEADD(day, 30, created_at) < GETDATE()` computes a value per row and cannot seek.', suggestion: 'Move the arithmetic to the constant side: `created_at < DATEADD(day, -30, GETDATE())`.' });
  if (new RegExp(String.raw`(?<![\w.])DATEDIFF\s*${ARGS}\s*(=|<>|!=|>|<|>=|<=)`, 'i').test(code)) ctx.fnIssue(['DATEDIFF'], { id: 'ms-datediff-where', severity: 'high', category: 'performance', title: 'DATEDIFF() in WHERE (non-sargable)', description: '`DATEDIFF(day, created_at, GETDATE()) < 30` evaluates per row, and DATEDIFF counts boundary crossings rather than elapsed time — a frequent off-by-one bug.', suggestion: 'Rewrite as `created_at >= DATEADD(day, -30, CAST(GETDATE() AS date))`.' });
  for (const fn of ['YEAR', 'MONTH', 'DATEPART', 'DAY']) ctx.amend(`fn-on-column-${fn}`, { suggestion: 'Compare the raw column to a half-open range (`dt >= \'20240101\' AND dt < \'20250101\'`); use the unambiguous `yyyymmdd` literal format so DATEFORMAT/language settings cannot flip month and day.' });
  for (const fn of ['LOWER', 'UPPER']) ctx.amend(`fn-on-column-${fn}`, { severity: 'medium', title: `${fn}() on a column in WHERE is usually redundant`, description: 'The default collations (`SQL_Latin1_General_CP1_CI_AS`, `…_CI_AS`) are already case-insensitive, and wrapping the column disables index seeks.', suggestion: 'Drop the function. If the column really is case-sensitive (`_CS_`), add a computed column `LOWER(col) PERSISTED` and index that.' });

  // ---- implicit conversion: NVARCHAR literal / parameter vs VARCHAR column ----
  const nLits = a.conditions.filter((c) => c.column && c.value && /^N\s*'/.test(c.value.trim()));
  if (nLits.length) ctx.add({ id: 'ms-nvarchar-implicit', severity: 'medium', category: 'performance', title: `N'…' literal compared to \`${nLits[0].column}\``, description: 'If the column is VARCHAR, data-type precedence converts the *column* to NVARCHAR row by row (CONVERT_IMPLICIT in the plan) and the index seek becomes a scan. Very common with ORM/ADO.NET parameters defaulting to NVARCHAR.', suggestion: 'Match the parameter/literal type to the column (`VARCHAR` → plain quotes, `SqlDbType.VarChar`), or change the column to NVARCHAR.' });
  const numVsText = a.conditions.filter((c) => c.column && c.op === '=' && c.value && /^\d+$/.test(c.value) && /(^|[._])(phone|mobile|zip|postcode|postal_code|code|sku|account_no|number|ref|reference)$/i.test(c.column));
  if (numVsText.length) ctx.add({ id: 'ms-implicit-numeric', severity: 'high', category: 'performance', title: `\`${numVsText[0].column}\` compared to a numeric literal`, description: 'If the column is (N)VARCHAR, SQL Server converts every row to INT (higher precedence) — a scan plus a possible "Conversion failed when converting the varchar value" error on the first non-numeric row.', suggestion: `Quote the value: \`${numVsText[0].column} = '${numVsText[0].value}'\`.` });

  // ---- @@IDENTITY ----
  if (/@@IDENTITY\b/i.test(code)) ctx.add({ id: 'ms-at-at-identity', severity: 'high', category: 'correctness', title: '@@IDENTITY returns the wrong id when triggers insert', description: '`@@IDENTITY` is the last identity generated in the session in *any* table — a trigger that inserts an audit row changes it.', suggestion: 'Use `SCOPE_IDENTITY()` or, better, the `OUTPUT INSERTED.id` clause.' });

  // ---- string concat with + and NULLs ----
  if (/[\w\]"']\s*\+\s*(N?'[^']*'|[\w.\[\]]+)\s*\+\s*/.test(ctx.sql) && /'[^']*'\s*\+|\+\s*N?'[^']*'/.test(ctx.sql) && !/\bCONCAT\s*\(/i.test(code)) ctx.add({ id: 'ms-plus-concat-null', severity: 'low', category: 'correctness', title: 'String concatenation with + propagates NULL', description: 'If any operand is NULL the whole expression is NULL (`first_name + \' \' + middle_name` vanishes for people without a middle name), unless `CONCAT_NULL_YIELDS_NULL` is off — which is deprecated.', suggestion: 'Use `CONCAT()` (treats NULL as empty) or `CONCAT_WS(\' \', …)` (2017+).' });

  // ---- DDL ----
  if (a.statementType === 'CREATE TABLE') {
    const maxCols = ctx.columns.filter((c) => /^N?VARCHAR\(MAX\)|^VARBINARY\(MAX\)/.test(c.type));
    if (maxCols.length >= 2 || (maxCols.length && ctx.columns.length <= 4)) ctx.add({ id: 'ms-varchar-max', severity: 'medium', category: 'performance', title: 'NVARCHAR(MAX) used as a default string type', description: `\`${maxCols.map((c) => c.name).join('`, `')}\` cannot be index keys, are excluded from online index rebuilds in older versions, force row-overflow / LOB storage, and make the optimizer assume 4000-byte averages for memory grants.`, suggestion: 'Use `NVARCHAR(n)` sized to the data (≤ 4000) and reserve MAX for genuinely large text.' });
    const guidPk = ctx.columns.find((c) => c.type === 'UNIQUEIDENTIFIER' && c.flags.includes('PK'));
    if (guidPk && !/NEWSEQUENTIALID/i.test(code)) ctx.add({ id: 'ms-guid-clustered', severity: 'high', category: 'performance', title: 'UNIQUEIDENTIFIER primary key → random clustered index', description: 'PRIMARY KEY is clustered by default; random GUIDs cause page splits and ~99% fragmentation on inserts, and the 16-byte key is copied into every nonclustered index.', suggestion: 'Declare the PK `NONCLUSTERED` and cluster on an `INT/BIGINT IDENTITY` or a datetime, or use `NEWSEQUENTIALID()` as the default.' });
    if (ctx.columns.some((c) => c.type === 'DATETIME')) ctx.add({ id: 'ms-datetime-legacy', severity: 'low', category: 'correctness', title: 'Legacy DATETIME type', description: '`DATETIME` rounds to 0.000, .003 or .007 seconds and only spans 1753–9999.', suggestion: 'Use `DATETIME2(3)` (or `DATETIMEOFFSET` when the zone matters) — it is more precise and, at precision ≤ 3, one byte smaller.' });
    if (ctx.columns.some((c) => /^(FLOAT|REAL)/.test(c.type) && /(price|amount|total|cost|balance|salary)/i.test(c.name))) ctx.amend('float-money', { suggestion: 'Use `DECIMAL(19,4)` (the `MONEY` type has silent rounding issues in intermediate arithmetic and is best avoided too).' });
    if (ctx.columns.some((c) => /^N?CHAR\((?:[2-9]\d|\d{3,})\)$/.test(c.type))) ctx.add({ id: 'ms-char-wide', severity: 'low', category: 'readability', title: 'Wide fixed-length CHAR column', description: 'CHAR(n) always stores and returns n characters padded with spaces (and `ANSI_PADDING` makes comparisons trap-prone).', suggestion: 'Use VARCHAR/NVARCHAR unless the value is truly fixed length (country codes, hashes).' });
    if (ctx.columns.some((c) => c.type === 'BIT' && !c.flags.includes('NOT NULL') && !c.flags.includes('DEFAULT'))) ctx.add({ id: 'ms-nullable-bit', severity: 'low', category: 'correctness', title: 'Nullable BIT column', description: 'A three-valued flag (0/1/NULL) is a bug magnet: `WHERE is_active <> 1` silently excludes NULLs.', suggestion: 'Declare flags `BIT NOT NULL DEFAULT 0`.' });
    ctx.amend('fk-index', { severity: 'medium', description: 'SQL Server does NOT create indexes on foreign-key columns. Without one, every DELETE on the parent scans the child table and the join cannot seek.' });
    ctx.amend('no-pk', { description: 'A table without a PRIMARY KEY (and without a clustered index) is a heap: forwarded records accumulate on updates, and there is no efficient way to address a row for replication or merge.' });
  }

  // ---- amend generic findings ----
  ctx.amend('agg-without-group', { description: (i) => i.description.replace(/Most databases reject this;.*$/, 'SQL Server raises error 8120: "Column … is invalid in the select list because it is not contained in either an aggregate function or the GROUP BY clause".') });
  ctx.amend('or-conditions', { suggestion: 'SQL Server can do an index union for OR, but often prefers a scan. Rewrite as `UNION ALL` of two seek-able queries, or use `OPTION (RECOMPILE)` when one branch is a catch-all (`@p IS NULL OR col = @p`).' });
  ctx.amend('double-wildcard', { suggestion: 'Create a `FULLTEXT INDEX` and use `CONTAINS(col, \'"term*"\')` / `FREETEXT`. `LIKE \'%term%\'` will always scan.' });
  ctx.amend('leading-wildcard', { suggestion: 'Use a full-text index with `CONTAINS`, or a persisted computed column `REVERSE(col)` (indexed) to turn suffix matches into prefix seeks.' });
  ctx.amend('scalar-subquery', { suggestion: 'Rewrite with `OUTER APPLY (SELECT COUNT(*) … WHERE inner.key = outer.key) x` or pre-aggregate in a CTE and `LEFT JOIN`. SQL Server often unnests scalar subqueries into a nested-loops join but not always.' });
  ctx.amend('order-random', { suggestion: '`ORDER BY NEWID()` sorts the whole table. Use `TABLESAMPLE (1 PERCENT)` for an approximate sample, or `WHERE (ABS(CAST(BINARY_CHECKSUM(*) AS int)) % 100) < 1`.' });
  ctx.amend('large-offset', { description: '`OFFSET … ROWS FETCH NEXT` still reads and discards all skipped rows — page 500 is 500× more expensive than page 1.', suggestion: 'Use keyset pagination: `WHERE created_at < @last_created_at OR (created_at = @last_created_at AND id < @last_id) ORDER BY created_at DESC, id DESC OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY` (row-value comparison is not supported).' });
  ctx.amend('large-in-list', { suggestion: 'Pass a table-valued parameter (`CREATE TYPE IdList AS TABLE (id INT PRIMARY KEY)`) or `STRING_SPLIT()`/`OPENJSON()` a delimited string and JOIN — huge IN lists blow up compile time and the 2100-parameter limit.' });
  ctx.amend('count-distinct', { description: 'Requires a Hash Match (Aggregate) on all values. Use `APPROX_COUNT_DISTINCT()` (SQL Server 2019+) for dashboards.' });
  ctx.amend('update-join', { description: 'T-SQL syntax is `UPDATE t SET t.col = s.col FROM target t JOIN source s ON …`. If several source rows match one target row, one wins arbitrarily and no error is raised — ensure a 1:1 match (or use `MERGE`, carefully).' });
  ctx.amend('delete-batch', { description: 'Use `DELETE TOP (5000) FROM t WHERE …` in a loop (`WHILE @@ROWCOUNT > 0`) so the transaction log stays small and lock escalation to the table level (≈5,000 locks) is avoided.' });
  ctx.amend('destructive', { description: 'Double-check target and environment. SQL Server DDL is transactional — run `BEGIN TRAN … ROLLBACK/COMMIT` so it can be undone.' });
  ctx.amend('index-locking', { severity: 'medium', title: 'CREATE INDEX takes a schema-modification lock', description: 'Offline index builds block all DML on the table for the duration (reads too, for a clustered index).', suggestion: 'Use `WITH (ONLINE = ON)` (Enterprise / Azure SQL / Standard from 2016 SP1 with limits) and consider `RESUMABLE = ON` for large tables (2017+).' });
  ctx.amend('index-writes', { description: 'INSERT/UPDATE/DELETE must maintain it. Check `sys.dm_db_index_usage_stats` — an index with many `user_updates` and zero seeks/scans is a candidate to drop.' });
  ctx.amend('alter-lock', { description: 'Adding a NOT NULL column with a default is metadata-only in Enterprise (2012+) but rewrites the table in other editions; changing a type or adding a column in the middle rewrites everything. `ALTER TABLE` takes a Sch-M lock that blocks all access — run in a maintenance window or use `ONLINE = ON` where supported.' });
  ctx.amend('looks-good', { description: 'The query structure is sound. Verify with `SET STATISTICS IO, TIME ON` and the actual execution plan that seeks (not scans) are used and no implicit conversion warnings appear.' });
  ctx.amend('in-subquery', { description: 'SQL Server converts `IN (SELECT …)` to a semi-join (Left Semi Join / Right Semi Join in the plan), so it performs the same as `EXISTS`.' });
  ctx.amend('implicit-cast', { description: (i) => i.description + ' SQL Server converts the side with lower data-type precedence; when that is the *column*, the plan shows `CONVERT_IMPLICIT` and the index cannot be sought.' });
  ctx.amend('order-not-selected', { description: 'SQL Server rejects this: "ORDER BY items must appear in the select list if SELECT DISTINCT is specified" (error 145).' });
  ctx.amend('varchar255', { description: 'Length affects memory-grant estimates (the optimizer assumes half the declared width per row). Size columns realistically, and use `NVARCHAR` only when you need Unicode.' });
  ctx.amend('union-all', { description: (i) => i.description + ' In SQL Server this shows up as a Sort (Distinct Sort) or Hash Match (Aggregate) operator over the combined set.' });
}

function rewrite(sql: string) {
  return applyRewrites(sql, [
    { re: new RegExp(String.raw`(?<![\w.])(?:ISNULL|COALESCE)\s*\(\s*${COL}\s*,\s*('[^']*'|-?\d+(?:\.\d+)?)\s*\)\s*=\s*\2(?![\w.])`, 'gi'), to: (_m, col, v) => `(${col} = ${v} OR ${col} IS NULL)`, note: 'Rewrote `ISNULL(col, v) = v` as `(col = v OR col IS NULL)` — each branch can now use an index seek.', fixes: 'ms-isnull-where' },
    { re: new RegExp(String.raw`(?<![\w.])CAST\s*\(\s*${COL}\s+AS\s+DATE\s*\)\s*=\s*'(\d{4})-?(\d{2})-?(\d{2})'`, 'gi'), to: (_m, col, y, mo, d) => dayRange(col, `${y}-${mo}-${d}`, (x) => `'${x.replace(/-/g, '')}'`), note: 'Rewrote `CAST(col AS date) = d` as a half-open range using unambiguous `yyyymmdd` literals.', fixes: 'ms-convert-where' },
    { re: new RegExp(String.raw`(?<![\w.])CONVERT\s*\(\s*(?:VAR)?CHAR\s*\(\s*\d+\s*\)\s*,\s*${COL}\s*,\s*112\s*\)\s*=\s*'(\d{4})(\d{2})(\d{2})'`, 'gi'), to: (_m, col, y, mo, d) => dayRange(col, `${y}-${mo}-${d}`, (x) => `'${x.replace(/-/g, '')}'`), note: 'Rewrote `CONVERT(varchar, col, 112) = \'yyyymmdd\'` as a half-open range on the raw column.', fixes: 'ms-convert-where' },
    { re: new RegExp(String.raw`(?<![\w.])DATEPART\s*\(\s*(?:YEAR|YY|YYYY)\s*,\s*${COL}\s*\)\s*=\s*(\d{4})`, 'gi'), to: (_m, col, y) => yearRange(col, y, (x) => `'${x.replace(/-/g, '')}'`), note: 'Rewrote `DATEPART(year, col) = y` as a sargable range.', fixes: 'fn-on-column-DATEPART' },
    { re: new RegExp(String.raw`(?<![\w.])YEAR\s*\(\s*${COL}\s*\)\s*=\s*(\d{4})\s+AND\s+MONTH\s*\(\s*\1\s*\)\s*=\s*(\d{1,2})`, 'gi'), to: (_m, col, y, mo) => monthRange(col, `${y}-${String(mo).padStart(2, '0')}`, (x) => `'${x.replace(/-/g, '')}'`), note: 'Rewrote `YEAR(col) = y AND MONTH(col) = m` as a single sargable range.', fixes: ['fn-on-column-YEAR', 'fn-on-column-MONTH'] },
    { re: new RegExp(String.raw`(?<![\w.])DATEADD\s*\(\s*(\w+)\s*,\s*(-?\d+)\s*,\s*${COL}\s*\)\s*(<|<=|>|>=)\s*(GETDATE\(\)|SYSDATETIME\(\)|GETUTCDATE\(\)|SYSUTCDATETIME\(\)|CURRENT_TIMESTAMP)`, 'gi'), to: (_m, unit, n, col, op, now) => `${col} ${op} DATEADD(${unit}, ${-Number(n)}, ${now})`, note: 'Moved DATEADD() from the column to the constant side so the predicate is sargable.', fixes: 'ms-dateadd-column' },
    // `LIMIT n` at end of a SELECT with ORDER BY → OFFSET/FETCH (only the simple trailing form)
    { re: /\bORDER\s+BY\s+([^;]+?)\s+LIMIT\s+(\d+)\s+OFFSET\s+(\d+)\s*$/i, to: (_m, ob, lim, off) => `ORDER BY ${ob} OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`, note: 'Converted `LIMIT … OFFSET …` to T-SQL `OFFSET … ROWS FETCH NEXT … ROWS ONLY`.', fixes: 'ms-foreign-syntax' },
    { re: /\bORDER\s+BY\s+([^;]+?)\s+LIMIT\s+(\d+)\s*$/i, to: (_m, ob, lim) => `ORDER BY ${ob} OFFSET 0 ROWS FETCH NEXT ${lim} ROWS ONLY`, note: 'Converted `LIMIT n` to T-SQL `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`.', fixes: 'ms-foreign-syntax' },
  ]);
}

export const mssql: DialectPack = {
  info: { id: 'mssql', label: 'SQL Server', short: 'MS', promptName: 'SQL Server (T-SQL)', formatter: 'transactsql', description: 'NOLOCK, TOP/OFFSET-FETCH, implicit conversions, NVARCHAR(MAX), GUID clustering, ONLINE = ON' },
  rules,
  rewrite,
  indexDdl: ({ table, name, columns }) => `CREATE NONCLUSTERED INDEX ${name} ON ${table} (${columns.join(', ')}) WITH (ONLINE = ON);`,
  explainTip: 'SET STATISTICS IO, TIME ON + the actual execution plan',
};
