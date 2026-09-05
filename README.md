<div align="center">

# 🔍 QueryLens

### Understand, optimize and learn SQL — without pasting your queries into the internet.

**A privacy-first SQL analyzer, explainer, optimizer and interactive learning playground that runs 100 % inside your browser tab.**

<br/>

[![Built with React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-7-646cff?logo=vite&logoColor=white)](https://vite.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-06b6d4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![SQLite via sql.js](https://img.shields.io/badge/SQLite-WebAssembly-003b57?logo=sqlite&logoColor=white)](https://sql.js.org)
[![Privacy](https://img.shields.io/badge/data%20leaves%20your%20machine-never-10b981)](#-privacy-model)
[![License](https://img.shields.io/badge/license-MIT-slate)](#-license)

<br/>

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  SELECT DISTINCT * FROM orders o, customers c WHERE YEAR(o.created_at)=2024  │
│                                                                              │
│  ● CRITICAL  Comparison with NULL using !=        → auto-fixed in rewrite   │
│  ● HIGH      YEAR() on a column (non-sargable)     → rewritten as a range    │
│  ● HIGH      NOT IN (subquery)                     → rewritten as NOT EXISTS │
│  ● MEDIUM    Implicit comma join                   → explicit JOIN … ON      │
│                                                                              │
│  💡 CREATE INDEX idx_orders_customer_id ON orders (customer_id);             │
└──────────────────────────────────────────────────────────────────────────────┘
```

</div>

---

## ✨ Why QueryLens?

Every developer has hit that moment: a query is slow, or confusing, or you inherited it — and the fastest way to understand it is to paste it into a search engine or an AI chatbot. Except that query contains your **table names, column names, customer emails, internal IDs** and business logic.

QueryLens fixes that trade-off:

| | |
|---|---|
| 🔒 **Zero uploads** | Parsing, analysis, rewriting and even *query execution* happen in JavaScript + WebAssembly on your machine. Disconnect from the internet — it still works. |
| 🧠 **Explains, doesn't just lint** | Plain-English walkthrough in *logical execution order* (FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT). |
| ⚡ **Rewrites safely** | Only applies transformations that provably preserve results, and tells you exactly what changed and why. |
| 🧪 **A real database, not a simulation** | The playground embeds SQLite; you get actual constraint errors and actual `EXPLAIN QUERY PLAN` output. |
| 🌳 **Live schema tree** | Watch tables, columns, types, keys, indexes, relationships and session variables appear and change as you type. |
| 🤖 **AI when *you* decide** | Generates an anonymised, goal-specific prompt for any LLM — and decodes the answer back to your real names locally. |

---

## 🧭 The three modes

### 1 · Analyze & Optimize

Paste any statement, pick a **dialect** (or leave it on *Generic SQL*), and get, in real time:

- **Explanation** — a numbered, colour-coded walkthrough of each clause. Conditions are humanised (`u.age >= 18` → "`u.age` is at least 18"), joins are described semantically (LEFT JOIN → "keep every row from the left side…").
- **Findings** — 50+ rules across five categories:

  | Category | Examples |
  |---|---|
  | 🐢 Performance | `SELECT *`, leading `LIKE '%…'`, functions on indexed columns, scalar N+1 subqueries, `ORDER BY RANDOM()`, huge `OFFSET`, `UNION` vs `UNION ALL`, `HAVING` that belongs in `WHERE` |
  | ✅ Correctness | `= NULL`, `NOT IN` with nullable subqueries, `LIMIT` without `ORDER BY`, aggregates mixed with bare columns, joins without `ON`, `NATURAL JOIN` fragility |
  | 🛡️ Safety | `UPDATE`/`DELETE` without `WHERE`, `DROP`/`TRUNCATE`, locking DDL |
  | 🔐 Security | injection-shaped predicates, literal values where parameters belong |
  | 📖 Readability | implicit comma joins, missing aliases, ordinal `ORDER BY`, deep nesting |

  Plus schema reviews for `CREATE TABLE` (missing PK, FLOAT for money, undeclared FKs, all-nullable columns…).
- **Optimized** — a semantics-preserving rewrite with a change log:
  `= NULL → IS NULL` · `YEAR(col) = y → half-open range` · `OR`-chains → `IN (…)` · `NOT IN (subq) → NOT EXISTS` · comma joins → explicit `JOIN … ON` · redundant `DISTINCT` removed · `LIKE` without wildcards → `=`
- **Indexes** — heuristic composite index suggestions (equality → range → sort columns) as ready-to-run DDL, in the selected dialect's syntax (`CREATE INDEX CONCURRENTLY`, `ALTER TABLE … ADD INDEX …, ALGORITHM=INPLACE`, `WITH (ONLINE = ON)`, …).
- **Structure** — tables, join graph, predicates (with sargability flags), grouping, sorting, parameters, complexity score.

#### Dialect-aware rule packs

The generic ruleset always runs. Choosing a dialect layers an engine-specific pack on top — it can **add** findings, **re-word** generic ones with the right advice for that engine, or **drop** ones that don't apply. Findings from a pack carry a small `PG` / `MY` / `MS` / `LITE` badge, and QueryLens will suggest switching when the SQL clearly looks like another engine's syntax (backticks, `TOP`, `::casts`, `AUTOINCREMENT`…).

| Dialect | Examples of what the pack catches |
|---|---|
| 🐘 **PostgreSQL** | `"Double-quoted strings"` are identifiers · quoted mixed-case names & case folding · `col::date = …` / `date_trunc()` in WHERE (auto-rewritten to a range) · `ILIKE`/`LOWER()` need `pg_trgm` or expression indexes · `NULLS FIRST` on `DESC` sorts · `SERIAL` → `IDENTITY` · `timestamp` without time zone · FK columns are not auto-indexed · `CREATE INDEX CONCURRENTLY` · MySQL/T-SQL syntax that won't parse |
| 🐬 **MySQL** | `ONLY_FULL_GROUP_BY` violations · `DATE_FORMAT()` in WHERE (auto-rewritten) · VARCHAR column compared to a number (row-by-row cast) · collation conversions in JOINs · `utf8` vs `utf8mb4` · MyISAM · `TIMESTAMP` 2038 limit · UUIDs in `CHAR(36)` PKs · `INT(11)` display widths · deferred-join pagination · Postgres/T-SQL syntax that won't parse |
| 🪟 **SQL Server** | `NOLOCK` · `TOP` without `ORDER BY` · `ISNULL(col, x) = x` (auto-rewritten to `col = x OR col IS NULL`) · `DATEDIFF`/`DATEADD`/`CONVERT` on columns · `N'…'` vs `VARCHAR` implicit conversion · `@@IDENTITY` · `+` concatenation swallowing NULLs · `NVARCHAR(MAX)` everywhere · random-GUID clustered keys · `LIMIT` → `OFFSET … FETCH` (auto-rewritten) |
| 🪶 **SQLite** | type affinity & `STRICT` · `INT PRIMARY KEY` is not a rowid alias · needless `AUTOINCREMENT` · `WITHOUT ROWID` · `PRAGMA foreign_keys` · `LIKE` vs `NOCASE` indexes · `strftime()` in WHERE (auto-rewritten) · `DECIMAL` is really a double · no `TRUNCATE`/`ALTER COLUMN` · double-quoted string fallback |

Your dialect choice is remembered locally and pre-fills the **Database** field in the AI Prompt Builder, so included findings are engine-specific there too.

### 2 · Interactive Playground *(learning mode)*

```sql
CREATE TABLE events (id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT);
-- …insert 2,000 rows…
SELECT COUNT(*) FROM events WHERE user_id = 7;      -- plan: SCAN events
CREATE INDEX idx_events_user ON events (user_id);
SELECT COUNT(*) FROM events WHERE user_id = 7;      -- plan: SEARCH events USING COVERING INDEX ✨
```

- Runs on an **in-memory SQLite** (via [sql.js](https://sql.js.org)) — foreign keys enforced, transactions supported.
- **Live database tree** with row counts, column types, PK/FK/NOT NULL badges, defaults, indexes, views, triggers and relationships. Changed tables pulse after every run.
- **Session variables**: `SET @amount = 200;` or `DECLARE @who TEXT = 'bob';` — typed, listed in the tree, substituted into later statements.
- **"What happened" log** — every statement becomes a sentence: *"Inserted 4 rows into `customers` (now 9)"*, *"Created index … — queries filtering on `user_id` can now use it"*, plus friendly explanations for errors like `no such column` or `FOREIGN KEY constraint failed`.
- **Query plan tab** — annotated `EXPLAIN QUERY PLAN` (🔍 scan, ✅ index search, 🚀 covering index, ↕️ temp B-tree for sort, 🛠️ automatic index = "you should add one").
- Run the whole script, or **select text to run just that part** (`Ctrl/⌘ + Enter`). Built-in scenarios: *E-commerce starter*, *Indexes & query plans*, *Variables & transactions*.

### 3 · AI Prompt Builder

Pick a goal — **Explain · Optimize · Debug · Index advice · Convert dialect · Security review · Refactor · Custom** — choose your database, add table sizes and context, and QueryLens writes a structured, expert-grade prompt.

Before anything is copied to your clipboard, it's **anonymised**:

```sql
-- what you wrote                         -- what the AI sees
SELECT c.email, o.total                   SELECT t2.col_5, t1.col_9
FROM orders o JOIN customers c            FROM table_1 t1 JOIN table_2 t2
  ON o.customer_id = c.id                   ON t1.col_1 = t2.col_2
WHERE c.email LIKE '%@acme.com'           WHERE t2.col_5 LIKE 'str_1'
```

The mapping (`table_1 ← orders`, `col_5 ← email`, …) **never leaves the page**. Paste the AI's answer back into the *Decode* box and your real names are restored. Optionally include your playground schema (anonymised with the same mapping) and the local analyzer's findings so the AI can confirm or refute them.

---

## 🚀 Quick start

**Prerequisites:** [Node.js](https://nodejs.org) 20 or newer.

```bash
# 1. clone / download the project, then:
cd querylens

# 2. install dependencies
npm install

# 3. run the dev server
npm run dev
```

Open the printed URL (usually `http://localhost:5173`).

### Production build

```bash
npm run build
```

Other scripts: `npm run typecheck` (strict TS) and `npm run check:dialects` (prints every sample's findings under every dialect pack — handy when adding rules).

Produces **a single self-contained `dist/index.html`** — JS, CSS *and the SQLite WebAssembly binary* are inlined. Open it directly from disk, drop it on any static host, or share it internally. No server, no telemetry, no external requests.

```bash
npx serve dist        # or: python -m http.server 8080 --directory dist
```

---

## 🔐 Privacy model

| What | Where it runs | Network? |
|---|---|---|
| Tokenizing & parsing | Browser (TypeScript) | None |
| Findings, rewrites, index suggestions | Browser (TypeScript) | None |
| Query execution & `EXPLAIN` | Browser (SQLite compiled to WebAssembly) | None* |
| Anonymisation & decoding | Browser | None |
| Persistence of your editor text | `localStorage` on your device only | None |
| Talking to an AI | **You** copy the anonymised prompt to wherever you choose | Only what you paste |

<sub>*The WASM binary is bundled into the build. In dev mode it is served from `node_modules` by Vite; a public CDN is used only as a last-resort fallback if the local file fails to load.</sub>

> **Heads-up:** the prompt builder warns you if a real identifier still appears in your free-text context outside the masked SQL block.

---

## 🏗️ Architecture

```
src/
├── App.tsx                        # shell: header, hero, mode switching, local persistence
├── components/
│   ├── AnalyzerView.tsx           # Analyze & Optimize mode (5 tabs)
│   ├── PlaygroundView.tsx         # Interactive playground (editor · results · log · plan)
│   ├── PromptBuilderView.tsx      # Goal picker · privacy toggles · prompt · decoder
│   ├── DbTree.tsx                 # Live schema tree (tables, columns, FKs, indexes, variables)
│   ├── SqlEditor.tsx              # Syntax-highlighted editor (overlay technique) + <SqlCode/>
│   ├── ResultTable.tsx            # Virtualised-ish result grid
│   └── ui.tsx                     # Panel, chips, toggles, copy button, rich text
└── lib/
    ├── tokenizer.ts               # Hand-written SQL tokenizer (strings, comments, params,
    │                              #   paren depth, soft-keyword reclassification)
    ├── analyzer.ts                # Structural parser → explanation · findings · rewrite · indexes
    ├── dialects/                  # Dialect rule packs layered on the generic ruleset
    │   ├── index.ts               #   registry, DIALECT_LIST, detectDialect()
    │   ├── types.ts               #   DialectPack / RuleContext contracts
    │   ├── shared.ts              #   foreign-syntax reporter, range rewrites, helpers
    │   ├── postgres.ts · mysql.ts · mssql.ts · sqlite.ts
    ├── db.ts                      # BrowserDb: sql.js wrapper, schema snapshots, diff-based
    │                              #   event log, session variables, EXPLAIN annotations
    ├── anonymizer.ts              # Identifier / literal masking with reversible mapping
    ├── prompt.ts                  # Goal-driven prompt templates
    └── samples.ts                 # Example queries & playground scenarios
```

**Design notes**

- **No heavyweight SQL parser.** A purpose-built tokenizer tracks parenthesis depth so clauses can be split at the right level; this keeps the bundle small and handles multiple dialects leniently (PostgreSQL, MySQL, SQL Server, SQLite syntax all tokenize fine).
- **Dialect packs are additive.** `analyzeSql(sql, { dialect })` runs the generic rules first, then hands the result to the pack through a small `RuleContext` (`add` / `amend` / `remove` / `fnIssue`). Packs never replace the parser, so a new engine is a single file: an `info` block, a `rules()` function, optional `rewrite()` regexes and an `indexDdl()` template. Add one to `DIALECT_PACKS` and it appears in the selector.
- **Rewrites are conservative by design.** Anything that could change the result set (e.g. `DISTINCT` after a join, scalar subqueries → `LEFT JOIN`) is surfaced as a *manual* suggestion instead of being applied automatically.
- **The playground diffs schema snapshots** before and after each statement to describe what changed, rather than trying to predict effects from the SQL text.
- **Single-file output** via `vite-plugin-singlefile`, so the whole tool can live on a USB stick or an air-gapped machine.

---

## 🛠️ Tech stack

| | |
|---|---|
| UI | [React 19](https://react.dev) · [Tailwind CSS 4](https://tailwindcss.com) · [lucide-react](https://lucide.dev) icons |
| Build | [Vite 7](https://vite.dev) · TypeScript 5.9 · `vite-plugin-singlefile` |
| Database | [sql.js](https://sql.js.org) (SQLite 3 compiled to WebAssembly) |
| Formatting | [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) |

---

## 🧪 Try these

Load an example from the dropdown in **Analyze** mode:

- **Slow report query** — 10 findings, 4 auto-fixes, index suggestions.
- **N+1 scalar subqueries** — see why `(SELECT COUNT(*) …)` in the select list hurts.
- **Dangerous UPDATE** — the one finding you never want to see in production.
- **CREATE TABLE review** — schema smells before they become migrations.

Or in **Playground**, load *Learn: indexes & query plans* and watch the plan flip from `SCAN` to `SEARCH … USING COVERING INDEX`.

---

## 🗺️ Roadmap ideas

- [x] Dialect-aware rule sets (PostgreSQL / MySQL / T-SQL / SQLite specific advice)
- [ ] More dialects (Oracle, MariaDB-specific, BigQuery, Snowflake) — see `src/lib/dialects/`
- [ ] Visual join-graph / ER diagram for the playground schema
- [ ] Import a `.sqlite` file or a `schema.sql` dump into the playground
- [ ] Export / import session as JSON
- [ ] Optional local-LLM integration (Ollama / WebLLM) so even the AI step stays on-device

Contributions and rule suggestions are very welcome — open an issue with a query and what you'd expect QueryLens to say about it.

---

## ⚠️ Disclaimer

Static analysis is heuristic. QueryLens doesn't know your data distribution, existing indexes or engine version — always confirm recommendations with `EXPLAIN (ANALYZE)` on production-like data. The playground uses **SQLite semantics**, which differ in places from other engines (type affinity, `LIMIT` syntax, date functions).

---

## 📄 License

MIT — do whatever you like, just keep the notice.

<div align="center">
<br/>
<sub>Made for developers who'd rather understand their SQL than upload it.</sub>
</div>
