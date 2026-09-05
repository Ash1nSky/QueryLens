import type { Database, SqlJsStatic } from 'sql.js';
import { splitStatements, tokenize } from './tokenizer';

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  defaultValue: string | null;
  fk?: { table: string; column: string };
}
export interface IndexInfo { name: string; unique: boolean; columns: string[]; auto: boolean }
export interface TableInfo {
  name: string;
  kind: 'table' | 'view';
  columns: ColumnInfo[];
  rowCount: number;
  indexes: IndexInfo[];
  sql: string;
}
export interface Relationship { fromTable: string; fromColumn: string; toTable: string; toColumn: string }
export interface SchemaSnapshot { tables: TableInfo[]; relationships: Relationship[]; triggers: string[] }

export interface SessionVariable { name: string; value: string | number | null; type: string; declared?: string }

export interface QueryResult { columns: string[]; values: (string | number | null | Uint8Array)[][] }

export interface ExecEvent {
  kind: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'drop' | 'alter' | 'variable' | 'other' | 'error';
  statement: string;
  message: string;
  details: string[];
  result?: QueryResult;
  plan?: string[];
  rowsAffected?: number;
  ms: number;
  ok: boolean;
}

let SQL: SqlJsStatic | null = null;

export async function loadSqlJs(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  const mod = await import('sql.js');
  const init = (mod as unknown as { default: (cfg?: object) => Promise<SqlJsStatic> }).default;
  const wasmLocal = (await import('sql.js/dist/sql-wasm-browser.wasm?url')).default;
  try {
    SQL = await init({ locateFile: () => wasmLocal });
  } catch (e) {
    console.warn('Local wasm failed, falling back to CDN', e);
    SQL = await init({ locateFile: (f: string) => `https://sql.js.org/dist/${f}` });
  }
  return SQL!;
}

export class BrowserDb {
  db: Database;
  variables = new Map<string, SessionVariable>();

  constructor(sql: SqlJsStatic) {
    this.db = new sql.Database();
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  reset(sql: SqlJsStatic) {
    this.db.close();
    this.db = new sql.Database();
    this.db.run('PRAGMA foreign_keys = ON;');
    this.variables.clear();
  }

  snapshot(): SchemaSnapshot {
    const tables: TableInfo[] = [];
    const relationships: Relationship[] = [];
    const master = this.query("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
    for (const row of master.values) {
      const [type, name, sql] = row as [string, string, string];
      const cols = this.query(`PRAGMA table_info("${name.replace(/"/g, '""')}")`);
      const fks = type === 'table' ? this.query(`PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`) : { columns: [], values: [] };
      const fkMap = new Map<string, { table: string; column: string }>();
      for (const fk of fks.values) {
        // id, seq, table, from, to, ...
        const [, , toTable, from, to] = fk as [number, number, string, string, string];
        fkMap.set(from, { table: toTable, column: to || 'id' });
        relationships.push({ fromTable: name, fromColumn: from, toTable, toColumn: to || 'id' });
      }
      const columns: ColumnInfo[] = cols.values.map((c) => {
        const [, cname, ctype, notnull, dflt, pk] = c as [number, string, string, number, string | null, number];
        return { name: cname, type: ctype || 'ANY', notNull: !!notnull, pk: !!pk, defaultValue: dflt, fk: fkMap.get(cname) };
      });
      let rowCount = 0;
      try { rowCount = Number(this.query(`SELECT COUNT(*) FROM "${name.replace(/"/g, '""')}"`).values[0][0]); } catch { rowCount = 0; }
      const indexes: IndexInfo[] = [];
      if (type === 'table') {
        const idx = this.query(`PRAGMA index_list("${name.replace(/"/g, '""')}")`);
        for (const i of idx.values) {
          const [, iname, unique, origin] = i as [number, string, number, string];
          const icols = this.query(`PRAGMA index_info("${iname.replace(/"/g, '""')}")`).values.map((r) => String(r[2]));
          indexes.push({ name: iname, unique: !!unique, columns: icols, auto: origin !== 'c' });
        }
      }
      tables.push({ name, kind: type as 'table' | 'view', columns, rowCount, indexes, sql: sql ?? '' });
    }
    const triggers = this.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").values.map((r) => String(r[0]));
    return { tables, relationships, triggers };
  }

  query(sql: string): QueryResult {
    const res = this.db.exec(sql);
    if (!res.length) return { columns: [], values: [] };
    return { columns: res[0].columns, values: res[0].values as QueryResult['values'] };
  }

  /** Substitute @variables with their literal values. */
  private substitute(sql: string): string {
    if (!this.variables.size) return sql;
    const tokens = tokenize(sql);
    let out = '';
    let last = 0;
    for (const t of tokens) {
      out += sql.slice(last, t.start);
      last = t.end;
      if (t.type === 'param' && t.value.startsWith('@')) {
        const v = this.variables.get(t.value.slice(1).toLowerCase());
        if (v) {
          out += v.value === null ? 'NULL' : typeof v.value === 'number' ? String(v.value) : `'${String(v.value).replace(/'/g, "''")}'`;
          continue;
        }
      }
      out += t.value;
    }
    return out + sql.slice(last);
  }

  private handleVariable(raw: string): ExecEvent | null {
    const start = performance.now();
    const stmt = stripLeadingComments(raw);
    // SET @x = expr   |   SET @x := expr   |  DECLARE @x TYPE [= expr]  | SELECT @x := expr (mysql) not supported
    let m = stmt.match(/^\s*SET\s+@(\w+)\s*(?::=|=)\s*([\s\S]+?)\s*$/i);
    let declared: string | undefined;
    if (!m) {
      const d = stmt.match(/^\s*DECLARE\s+@(\w+)\s+([\w()]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)\s*(?:(?:=|:=|DEFAULT)\s*([\s\S]+?))?\s*$/i);
      if (!d) return null;
      declared = d[2].toUpperCase();
      m = [d[0], d[1], d[3] ?? 'NULL'] as unknown as RegExpMatchArray;
    }
    const name = m[1];
    const expr = this.substitute(m[2]);
    try {
      const r = this.query(`SELECT (${expr}) AS v, typeof(${expr}) AS t`);
      const value = r.values[0][0] as string | number | null;
      const type = String(r.values[0][1]);
      this.variables.set(name.toLowerCase(), { name, value, type: type.toUpperCase(), declared });
      return { kind: 'variable', statement: stmt, ok: true, ms: performance.now() - start, message: `Variable @${name} set to ${value === null ? 'NULL' : JSON.stringify(value)}`, details: [`Inferred SQL type: ${type.toUpperCase()}${declared ? ` (declared as ${declared})` : ''}`, 'Use @' + name + ' in later statements; it is substituted before execution.'] };
    } catch (e) {
      return { kind: 'error', statement: stmt, ok: false, ms: performance.now() - start, message: `Could not evaluate variable: ${(e as Error).message}`, details: [] };
    }
  }

  /** Execute a script, returning one event per statement. */
  execScript(script: string): { events: ExecEvent[]; snapshot: SchemaSnapshot } {
    const statements = splitStatements(script);
    const events: ExecEvent[] = [];
    let before = this.snapshot();
    for (const raw of statements) {
      const varEvent = this.handleVariable(raw);
      if (varEvent) { events.push(varEvent); continue; }
      const stmt = this.substitute(raw);
      const start = performance.now();
      const firstWord = mainVerb(stmt);
      try {
        let plan: string[] | undefined;
        if (['SELECT', 'UPDATE', 'DELETE'].includes(firstWord) || (firstWord === 'INSERT' && /\bSELECT\b/i.test(stmt))) {
          try { plan = this.query(`EXPLAIN QUERY PLAN ${stmt}`).values.map((r) => String(r[3])); } catch { plan = undefined; }
        }
        if (firstWord === 'SELECT' || firstWord === 'PRAGMA' || firstWord === 'EXPLAIN' || firstWord === 'VALUES') {
          const result = this.query(stmt);
          const ms = performance.now() - start;
          events.push({ kind: 'select', statement: raw, ok: true, ms, result, plan, message: `Returned ${result.values.length} row${result.values.length !== 1 ? 's' : ''} × ${result.columns.length} column${result.columns.length !== 1 ? 's' : ''}`, details: describePlan(plan) });
          continue;
        }
        // mutation / DDL — capture RETURNING output if any
        let result: QueryResult | undefined;
        if (/\bRETURNING\b/i.test(stmt)) result = this.query(stmt); else this.db.run(stmt);
        const rowsAffected = this.db.getRowsModified();
        const ms = performance.now() - start;
        const after = this.snapshot();
        const ev = diffEvent(firstWord, raw, before, after, rowsAffected, ms, stripLeadingComments(stmt));
        if (result) ev.result = result;
        if (plan) ev.plan = plan;
        events.push(ev);
        before = after;
      } catch (e) {
        events.push({ kind: 'error', statement: raw, ok: false, ms: performance.now() - start, message: (e as Error).message, details: explainError((e as Error).message) });
      }
    }
    return { events, snapshot: this.snapshot() };
  }

  tableSample(name: string, limit = 50): QueryResult {
    return this.query(`SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT ${limit}`);
  }

  exportSchemaDdl(): string {
    const rows = this.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name");
    return rows.values.map((r) => String(r[0]) + ';').join('\n\n');
  }
}

function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); continue; }
    return t;
  }
}

/** The main verb of a statement (looks past CTE definitions for WITH ... INSERT/UPDATE/DELETE). */
function mainVerb(stmt: string): string {
  const tokens = tokenize(stmt).filter((t) => t.type !== 'comment');
  const first = tokens[0]?.upper ?? '';
  if (first !== 'WITH') return first;
  const verb = tokens.find((t, i) => i > 0 && t.depth === 0 && t.type === 'keyword' && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(t.upper));
  return verb?.upper ?? 'SELECT';
}

function describePlan(plan?: string[]): string[] {
  if (!plan || !plan.length) return [];
  const out: string[] = [];
  for (const p of plan) {
    if (/SCAN\s+\w+(\s+AS\s+\w+)?$/i.test(p) || (/^SCAN /i.test(p) && !/USING/i.test(p))) out.push(`🔍 ${p} — full table scan: every row is read. Fine for small tables; add an index for large ones.`);
    else if (/USING COVERING INDEX/i.test(p)) out.push(`🚀 ${p} — answered entirely from the index, the table itself is not touched.`);
    else if (/USING INDEX|USING INTEGER PRIMARY KEY/i.test(p)) out.push(`✅ ${p} — index lookup, only matching rows are read.`);
    else if (/USE TEMP B-TREE FOR ORDER BY/i.test(p)) out.push(`↕️ ${p} — the result is sorted in a temporary structure; an index matching the ORDER BY could avoid this.`);
    else if (/USE TEMP B-TREE FOR (GROUP BY|DISTINCT)/i.test(p)) out.push(`🧮 ${p} — grouping/dedup uses a temporary structure.`);
    else if (/CORRELATED SCALAR SUBQUERY/i.test(p)) out.push(`⚠️ ${p} — this subquery runs once per outer row.`);
    else if (/SCALAR SUBQUERY|LIST SUBQUERY|CO-ROUTINE|MATERIALIZE/i.test(p)) out.push(`📦 ${p}`);
    else if (/AUTOMATIC/i.test(p)) out.push(`🛠️ ${p} — SQLite built a temporary index on the fly because none existed (a hint that a real index would help).`);
    else out.push(`• ${p}`);
  }
  return out;
}

function explainError(msg: string): string[] {
  const tips: string[] = [];
  if (/no such table/i.test(msg)) tips.push('The table does not exist yet. Create it first with CREATE TABLE, or check spelling — look at the schema tree on the right.');
  if (/no such column/i.test(msg)) tips.push('That column is not defined on the referenced table(s). Expand the table in the tree to see its columns; check aliases too.');
  if (/syntax error/i.test(msg)) tips.push('SQLite could not parse the statement near the quoted token. Common causes: missing comma, unbalanced parentheses, or a keyword used as a name without quotes.');
  if (/UNIQUE constraint failed/i.test(msg)) tips.push('A row with that key already exists. Use a different value, or INSERT OR REPLACE / ON CONFLICT to upsert.');
  if (/NOT NULL constraint failed/i.test(msg)) tips.push('A required column was left empty. Provide a value or give the column a DEFAULT.');
  if (/FOREIGN KEY constraint failed/i.test(msg)) tips.push('The referenced parent row does not exist (or you are deleting a parent that still has children). Foreign keys are enforced in this playground.');
  if (/ambiguous column/i.test(msg)) tips.push('Two joined tables share that column name. Qualify it with a table alias, e.g. `u.id`.');
  if (/misuse of aggregate/i.test(msg)) tips.push('Aggregates like COUNT() cannot be used in WHERE — use HAVING after GROUP BY.');
  if (/datatype mismatch/i.test(msg)) tips.push('A value of the wrong type was inserted into a strictly typed column (e.g. text into an INTEGER PRIMARY KEY).');
  if (/already exists/i.test(msg)) tips.push('Use `CREATE TABLE IF NOT EXISTS` or DROP it first.');
  return tips;
}

function diffEvent(firstWord: string, raw: string, before: SchemaSnapshot, after: SchemaSnapshot, rowsAffected: number, ms: number, stmt: string): ExecEvent {
  const bNames = new Map(before.tables.map((t) => [t.name, t]));
  const aNames = new Map(after.tables.map((t) => [t.name, t]));
  const created = after.tables.filter((t) => !bNames.has(t.name));
  const dropped = before.tables.filter((t) => !aNames.has(t.name));
  const details: string[] = [];
  let kind: ExecEvent['kind'] = 'other';
  let message = `${firstWord} executed`;

  if (created.length) {
    kind = 'create';
    const t = created[0];
    message = `Created ${t.kind} "${t.name}" with ${t.columns.length} column${t.columns.length !== 1 ? 's' : ''}`;
    for (const c of t.columns) details.push(`${c.name}: ${c.type}${c.pk ? ' · PRIMARY KEY' : ''}${c.notNull ? ' · NOT NULL' : ''}${c.fk ? ` · → ${c.fk.table}.${c.fk.column}` : ''}${c.defaultValue !== null && c.defaultValue !== undefined ? ` · DEFAULT ${c.defaultValue}` : ''}`);
    if (t.kind === 'table' && !t.columns.some((c) => c.pk)) details.push('ℹ No primary key declared — SQLite uses a hidden rowid.');
  } else if (dropped.length) {
    kind = 'drop';
    message = `Dropped ${dropped[0].kind} "${dropped[0].name}" (${dropped[0].rowCount} row${dropped[0].rowCount !== 1 ? 's' : ''} lost)`;
  } else if (firstWord === 'INSERT' || firstWord === 'REPLACE') {
    kind = 'insert';
    const changed = after.tables.filter((t) => (bNames.get(t.name)?.rowCount ?? 0) !== t.rowCount);
    const target = changed[0];
    message = `Inserted ${rowsAffected} row${rowsAffected !== 1 ? 's' : ''}${target ? ` into "${target.name}" (now ${target.rowCount} row${target.rowCount !== 1 ? 's' : ''})` : ''}`;
    if (rowsAffected === 0) details.push('No rows were added — a conflict clause may have skipped them.');
  } else if (firstWord === 'UPDATE') {
    kind = 'update';
    const m = stmt.match(/^\s*UPDATE\s+(?:OR\s+\w+\s+)?["`]?(\w+)/i);
    message = `Updated ${rowsAffected} row${rowsAffected !== 1 ? 's' : ''}${m ? ` in "${m[1]}"` : ''}`;
    if (rowsAffected === 0) details.push('No rows matched the WHERE clause (or values were already equal).');
    if (!/\bWHERE\b/i.test(stmt)) details.push('⚠ No WHERE clause — every row in the table was updated.');
  } else if (firstWord === 'DELETE') {
    kind = 'delete';
    const m = stmt.match(/^\s*DELETE\s+FROM\s+["`]?(\w+)/i);
    const t = m ? aNames.get(m[1]) : undefined;
    message = `Deleted ${rowsAffected} row${rowsAffected !== 1 ? 's' : ''}${m ? ` from "${m[1]}"` : ''}${t ? ` (${t.rowCount} remaining)` : ''}`;
    if (!/\bWHERE\b/i.test(stmt)) details.push('⚠ No WHERE clause — the whole table was emptied.');
  } else if (firstWord === 'ALTER') {
    kind = 'alter';
    const changedTables = after.tables.filter((t) => { const b = bNames.get(t.name); return b && (b.columns.length !== t.columns.length || b.columns.map((c) => c.name + c.type).join() !== t.columns.map((c) => c.name + c.type).join()); });
    message = `Altered ${changedTables.length ? `"${changedTables[0].name}"` : 'table'}`;
    for (const t of changedTables) {
      const b = bNames.get(t.name)!;
      const addedCols = t.columns.filter((c) => !b.columns.some((x) => x.name === c.name));
      const removedCols = b.columns.filter((c) => !t.columns.some((x) => x.name === c.name));
      addedCols.forEach((c) => details.push(`+ column ${c.name} ${c.type}`));
      removedCols.forEach((c) => details.push(`− column ${c.name}`));
    }
    if (!changedTables.length && created.length === 0) details.push('Table renamed or constraint changed.');
  } else if (firstWord === 'CREATE') {
    kind = 'create';
    // index or trigger
    const newIdx = after.tables.flatMap((t) => t.indexes.filter((i) => !bNames.get(t.name)?.indexes.some((x) => x.name === i.name)).map((i) => ({ t, i })));
    if (newIdx.length) { const { t, i } = newIdx[0]; message = `Created ${i.unique ? 'unique ' : ''}index "${i.name}" on ${t.name}(${i.columns.join(', ')})`; details.push('Queries filtering or sorting on ' + i.columns.join(', ') + ' can now use this index instead of scanning. Check the query plan!'); }
    else if (after.triggers.length > before.triggers.length) message = `Created trigger "${after.triggers.find((x) => !before.triggers.includes(x))}"`;
    else message = 'Created object';
  } else if (firstWord === 'DROP') {
    kind = 'drop';
    const lostIdx = before.tables.flatMap((t) => t.indexes.filter((i) => !aNames.get(t.name)?.indexes.some((x) => x.name === i.name)));
    message = lostIdx.length ? `Dropped index "${lostIdx[0].name}"` : 'Dropped object';
  } else if (firstWord === 'BEGIN' || firstWord === 'COMMIT' || firstWord === 'ROLLBACK') {
    message = `${firstWord} transaction`;
    details.push(firstWord === 'BEGIN' ? 'Changes are now provisional until COMMIT; ROLLBACK undoes them.' : firstWord === 'COMMIT' ? 'All changes since BEGIN are now permanent.' : 'All changes since BEGIN were discarded.');
  }
  return { kind, statement: raw, ok: true, ms, rowsAffected, message, details };
}
