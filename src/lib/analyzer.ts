import { format } from 'sql-formatter';
import { AGGREGATES, WINDOW_FUNCS, Token, joinTokens, stripComments, tokenize, unquoteIdent } from './tokenizer';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'good';

export interface Issue {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  suggestion?: string;
  autoFixed?: boolean;
  category: 'performance' | 'correctness' | 'readability' | 'safety' | 'security';
}

export interface TableRef {
  name: string;
  alias?: string;
  joinType: string; // 'FROM' | 'INNER JOIN' | 'LEFT JOIN' | ... | 'COMMA'
  condition?: string;
  isSubquery: boolean;
}

export interface Condition {
  raw: string;
  column?: string; // e.g. u.age
  op?: string;
  value?: string;
  connector?: 'AND' | 'OR';
  negated?: boolean;
  hasSubquery: boolean;
  wrappedColumn?: string; // function name wrapping the column
  children?: Condition[]; // for parenthesised groups
  groupOp?: 'AND' | 'OR';
}

export interface ExplanationStep {
  order: number;
  clause: string;
  title: string;
  details: string[];
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  ddl: string;
}

export interface QueryAnalysis {
  original: string;
  formatted: string;
  statementType: string;
  summary: string;
  tables: TableRef[];
  selectColumns: string[];
  selectStar: boolean;
  distinct: boolean;
  conditions: Condition[];
  whereText?: string;
  groupBy: string[];
  having?: string;
  orderBy: { expr: string; dir: string }[];
  limit?: string;
  offset?: string;
  ctes: string[];
  subqueryCount: number;
  maxDepth: number;
  aggregates: string[];
  windowFunctions: string[];
  setOperations: string[];
  parameters: string[];
  explanation: ExplanationStep[];
  issues: Issue[];
  rewritten?: string;
  rewriteNotes: string[];
  indexSuggestions: IndexSuggestion[];
  complexity: { score: number; label: string; factors: string[] };
  parseError?: string;
}

// ---------- helpers ----------
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER']);

function findTopLevel(tokens: Token[], baseDepth: number, pred: (t: Token, i: number) => boolean, from = 0, to = tokens.length): number {
  for (let i = from; i < to; i++) {
    if (tokens[i].depth === baseDepth && pred(tokens[i], i)) return i;
  }
  return -1;
}

function isKw(t: Token | undefined, ...words: string[]): boolean {
  return !!t && (t.type === 'keyword' || t.type === 'identifier' || t.type === 'function') && words.includes(t.upper);
}

function splitTopLevel(tokens: Token[], baseDepth: number, isSep: (t: Token) => boolean): Token[][] {
  const groups: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (t.depth === baseDepth && isSep(t)) { groups.push(cur); cur = []; } else cur.push(t);
  }
  groups.push(cur);
  return groups;
}

function humanOp(op: string): string {
  switch (op) {
    case '=': return 'equals';
    case '<>': case '!=': return 'is not equal to';
    case '>': return 'is greater than';
    case '>=': return 'is at least';
    case '<': return 'is less than';
    case '<=': return 'is at most';
    case 'LIKE': return 'matches the pattern';
    case 'ILIKE': return 'matches (case-insensitively) the pattern';
    case 'NOT LIKE': return 'does not match the pattern';
    case 'IN': return 'is one of';
    case 'NOT IN': return 'is not one of';
    case 'BETWEEN': return 'is between';
    case 'NOT BETWEEN': return 'is not between';
    case 'IS NULL': return 'is missing (NULL)';
    case 'IS NOT NULL': return 'has a value (is not NULL)';
    case 'EXISTS': return 'has at least one matching row in the subquery';
    case 'NOT EXISTS': return 'has no matching rows in the subquery';
    default: return op.toLowerCase();
  }
}

function describeJoin(joinType: string): string {
  switch (joinType) {
    case 'LEFT JOIN': case 'LEFT OUTER JOIN': return 'keep every row from the left side; where nothing matches on the right, fill with NULLs';
    case 'RIGHT JOIN': case 'RIGHT OUTER JOIN': return 'keep every row from the right side; unmatched left rows become NULLs';
    case 'FULL JOIN': case 'FULL OUTER JOIN': return 'keep all rows from both sides, filling NULLs where there is no match';
    case 'CROSS JOIN': return 'pair every row on the left with every row on the right (cartesian product)';
    case 'NATURAL JOIN': return 'match automatically on all columns with the same name';
    case 'COMMA': return 'implicit (comma) join — a cartesian product unless filtered in WHERE';
    default: return 'keep only rows where a match exists on both sides';
  }
}

// ---------- condition parsing ----------
function parseCondition(tokens: Token[], baseDepth: number): Condition {
  const raw = joinTokens(tokens);
  const c: Condition = { raw, hasSubquery: tokens.some((t) => isKw(t, 'SELECT') && t.depth > baseDepth) };
  let ts = tokens;
  // strip surrounding parens
  while (ts.length >= 2 && ts[0].value === '(' && ts[ts.length - 1].value === ')' && ts[0].depth === baseDepth) {
    ts = ts.slice(1, -1);
    baseDepth++;
  }
  if (ts.length === 0) return c;
  // parenthesised group containing AND/OR at this depth
  if (ts.some((t) => t.depth === baseDepth && isKw(t, 'AND', 'OR')) && ts !== tokens) {
    const children = parseWhere(ts, baseDepth);
    if (children.length > 1) {
      c.children = children;
      c.groupOp = children.some((ch) => ch.connector === 'OR') ? 'OR' : 'AND';
      c.op = 'GROUP';
      return c;
    }
  }
  if (isKw(ts[0], 'NOT')) { c.negated = true; ts = ts.slice(1); }
  if (isKw(ts[0], 'EXISTS')) { c.op = c.negated ? 'NOT EXISTS' : 'EXISTS'; c.value = joinTokens(ts.slice(1)); return c; }

  // find operator at baseDepth
  let opIdx = -1;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.depth !== baseDepth) continue;
    if (t.type === 'operator' && ['=', '<>', '!=', '>', '>=', '<', '<=', '<=>'].includes(t.value)) { opIdx = i; break; }
    if (isKw(t, 'LIKE', 'ILIKE', 'IN', 'BETWEEN', 'IS', 'GLOB', 'REGEXP') || (isKw(t, 'NOT') && i > 0)) { opIdx = i; break; }
  }
  if (opIdx === -1) return c;
  const left = ts.slice(0, opIdx);
  let opTokens = [ts[opIdx]];
  let rightStart = opIdx + 1;
  if (isKw(ts[opIdx], 'NOT')) { opTokens = [ts[opIdx], ts[opIdx + 1]]; rightStart = opIdx + 2; }
  if (isKw(ts[opIdx], 'IS') && isKw(ts[opIdx + 1], 'NOT')) { opTokens = [ts[opIdx], ts[opIdx + 1]]; rightStart = opIdx + 2; }
  const right = ts.slice(rightStart);
  let op = opTokens.map((t) => t.upper).join(' ');
  if (op === 'IS' || op === 'IS NOT') {
    if (isKw(right[0], 'NULL')) op = op + ' NULL';
  }
  c.op = op;
  c.value = joinTokens(right);
  // left side analysis
  if (left.length === 1 && left[0].type === 'identifier') c.column = left[0].value;
  else if (left.length === 3 && left[1].value === '.' ) c.column = joinTokens(left);
  else if (left.length >= 3 && left[0].type === 'function' && left[1].value === '(') {
    c.wrappedColumn = left[0].upper;
    const inner = left.slice(2, -1).filter((t) => t.type === 'identifier');
    if (inner.length) c.column = inner.map((t) => t.value).join('.');
  } else if (left.some((t) => t.type === 'identifier') && left.some((t) => t.type === 'operator')) {
    c.wrappedColumn = 'ARITHMETIC';
    const ident = left.find((t) => t.type === 'identifier');
    if (ident) c.column = ident.value;
  }
  return c;
}

function conditionToEnglish(c: Condition): string {
  if (c.op === 'GROUP' && c.children) {
    return `${c.groupOp === 'OR' ? 'ANY of these holds' : 'ALL of these hold'}: ${c.children.map((ch) => conditionToEnglish(ch)).join(c.groupOp === 'OR' ? '; or ' : '; and ')}`;
  }
  if (!c.op) return `the expression \`${c.raw}\` is true`;
  const col = c.column ? `\`${c.column}\`` : `\`${c.raw.split(' ')[0]}\``;
  if (c.op === 'EXISTS' || c.op === 'NOT EXISTS') return `${c.op === 'EXISTS' ? 'there exists' : 'there is no'} row in the subquery ${c.value}`;
  if (c.op.endsWith('NULL')) return `${col} ${humanOp(c.op)}`;
  if (c.op === 'BETWEEN' || c.op === 'NOT BETWEEN') {
    const parts = (c.value ?? '').split(/\s+AND\s+/i);
    return `${col} ${humanOp(c.op)} ${parts[0]} and ${parts[1] ?? '?'}`;
  }
  const wrapped = c.wrappedColumn && c.wrappedColumn !== 'ARITHMETIC' ? `${c.wrappedColumn}(${c.column})` : c.wrappedColumn === 'ARITHMETIC' ? c.raw.split(/\s(=|<>|!=|>=|<=|>|<)\s/)[0] : null;
  const subject = wrapped ? `\`${wrapped}\`` : col;
  const val = c.hasSubquery ? 'the result of a subquery' : c.value;
  return `${c.negated ? 'NOT (' : ''}${subject} ${humanOp(c.op)} ${val}${c.negated ? ')' : ''}`;
}

// ---------- main SELECT parsing ----------
interface SelectParts {
  selectTokens: Token[];
  fromTokens: Token[];
  whereTokens: Token[];
  groupTokens: Token[];
  havingTokens: Token[];
  orderTokens: Token[];
  limitTokens: Token[];
  offsetTokens: Token[];
  baseDepth: number;
}

function splitSelect(tokens: Token[], baseDepth: number): SelectParts {
  const idx = (pred: (t: Token, i: number) => boolean, from = 0) => findTopLevel(tokens, baseDepth, pred, from);
  const selectIdx = idx((t) => isKw(t, 'SELECT'));
  const fromIdx = idx((t) => isKw(t, 'FROM'), selectIdx + 1);
  const whereIdx = idx((t) => isKw(t, 'WHERE'), selectIdx + 1);
  const groupIdx = idx((t, i) => isKw(t, 'GROUP') && isKw(tokens[i + 1], 'BY'), selectIdx + 1);
  const havingIdx = idx((t) => isKw(t, 'HAVING'), selectIdx + 1);
  const orderIdx = idx((t, i) => isKw(t, 'ORDER') && isKw(tokens[i + 1], 'BY'), selectIdx + 1);
  const limitIdx = idx((t) => isKw(t, 'LIMIT'), selectIdx + 1);
  const offsetIdx = idx((t) => isKw(t, 'OFFSET'), selectIdx + 1);
  const fetchIdx = idx((t) => isKw(t, 'FETCH'), selectIdx + 1);
  const marks = [selectIdx, fromIdx, whereIdx, groupIdx, havingIdx, orderIdx, limitIdx, offsetIdx, fetchIdx].filter((i) => i >= 0).sort((a, b) => a - b);
  const endOf = (i: number) => {
    if (i < 0) return -1;
    const nextMark = marks.find((m) => m > i);
    return nextMark === undefined ? tokens.length : nextMark;
  };
  const slice = (i: number, skip: number) => (i < 0 ? [] : tokens.slice(i + skip, endOf(i)));
  return {
    selectTokens: slice(selectIdx, 1),
    fromTokens: slice(fromIdx, 1),
    whereTokens: slice(whereIdx, 1),
    groupTokens: slice(groupIdx, 2),
    havingTokens: slice(havingIdx, 1),
    orderTokens: slice(orderIdx, 2),
    limitTokens: slice(limitIdx, 1),
    offsetTokens: slice(offsetIdx, 1),
    baseDepth,
  };
}

function parseFrom(fromTokens: Token[], baseDepth: number): TableRef[] {
  const refs: TableRef[] = [];
  if (fromTokens.length === 0) return refs;
  // segment by JOIN keywords / commas at base depth
  const segments: { joinType: string; tokens: Token[] }[] = [];
  let cur: Token[] = [];
  let curType = 'FROM';
  let i = 0;
  while (i < fromTokens.length) {
    const t = fromTokens[i];
    if (t.depth === baseDepth && t.value === ',') {
      segments.push({ joinType: curType, tokens: cur }); cur = []; curType = 'COMMA'; i++; continue;
    }
    if (t.depth === baseDepth && isKw(t, ...Array.from(JOIN_WORDS))) {
      // collect join words
      const words: string[] = [];
      while (i < fromTokens.length && fromTokens[i].depth === baseDepth && isKw(fromTokens[i], ...Array.from(JOIN_WORDS))) { words.push(fromTokens[i].upper); i++; }
      if (words.includes('JOIN')) {
        segments.push({ joinType: curType, tokens: cur }); cur = [];
        curType = words.join(' ');
        if (curType === 'JOIN') curType = 'INNER JOIN';
        continue;
      }
    }
    cur.push(t); i++;
  }
  segments.push({ joinType: curType, tokens: cur });

  for (const seg of segments) {
    const ts = seg.tokens;
    if (ts.length === 0) continue;
    const onIdx = ts.findIndex((t) => t.depth === baseDepth && isKw(t, 'ON'));
    const usingIdx = ts.findIndex((t) => t.depth === baseDepth && isKw(t, 'USING'));
    const condStart = onIdx >= 0 ? onIdx : usingIdx;
    const head = condStart >= 0 ? ts.slice(0, condStart) : ts;
    const cond = condStart >= 0 ? joinTokens(ts.slice(condStart + 1)) : undefined;
    let name = '';
    let alias: string | undefined;
    let isSubquery = false;
    if (head[0]?.value === '(') {
      isSubquery = true;
      name = '(subquery)';
      const close = head.findIndex((t, k) => k > 0 && t.value === ')' && t.depth === baseDepth);
      const rest = head.slice(close + 1);
      const a = rest.find((t) => t.type === 'identifier');
      alias = a?.value;
    } else {
      // name possibly schema.name
      let k = 0;
      const parts: string[] = [];
      while (k < head.length && (head[k].type === 'identifier' || head[k].type === 'keyword' || head[k].value === '.')) {
        if (head[k].value !== '.') parts.push(unquoteIdent(head[k].value));
        k++;
        if (head[k]?.value !== '.') break;
      }
      name = parts.join('.');
      const rest = head.slice(k);
      const asIdx = rest.findIndex((t) => isKw(t, 'AS'));
      const aliasTok = asIdx >= 0 ? rest[asIdx + 1] : rest.find((t) => t.type === 'identifier');
      if (aliasTok && aliasTok.type !== 'keyword') alias = unquoteIdent(aliasTok.value);
    }
    if (!name) continue;
    refs.push({ name, alias, joinType: seg.joinType, condition: cond ? (usingIdx >= 0 && onIdx < 0 ? `USING ${cond}` : cond) : undefined, isSubquery });
  }
  return refs;
}

function parseWhere(whereTokens: Token[], baseDepth: number): Condition[] {
  if (whereTokens.length === 0) return [];
  const out: Condition[] = [];
  let cur: Token[] = [];
  let connector: 'AND' | 'OR' | undefined;
  let hasNotPrefix = false;
  for (let i = 0; i < whereTokens.length; i++) {
    const t = whereTokens[i];
    const prevIsBetween = cur.some((x) => isKw(x, 'BETWEEN')) && !cur.some((x, k) => k > cur.findIndex((y) => isKw(y, 'BETWEEN')) && isKw(x, 'AND'));
    if (t.depth === baseDepth && isKw(t, 'AND', 'OR') && !prevIsBetween) {
      if (cur.length) { const c = parseCondition(cur, baseDepth); c.connector = connector; out.push(c); }
      connector = t.upper as 'AND' | 'OR';
      cur = [];
      hasNotPrefix = false;
      continue;
    }
    cur.push(t);
  }
  void hasNotPrefix;
  if (cur.length) { const c = parseCondition(cur, baseDepth); c.connector = connector; out.push(c); }
  return out;
}

function flattenConditions(conds: Condition[]): Condition[] {
  const out: Condition[] = [];
  for (const c of conds) { out.push(c); if (c.children) out.push(...flattenConditions(c.children)); }
  return out;
}

function splitList(tokens: Token[], baseDepth: number): string[] {
  return splitTopLevel(tokens, baseDepth, (t) => t.value === ',').map((g) => joinTokens(g)).filter(Boolean);
}

// ---------- analysis ----------
export function analyzeSql(sql: string): QueryAnalysis {
  const original = sql;
  const allTokens = tokenize(sql);
  const tokens = stripComments(allTokens).filter((t) => !(t.type === 'punct' && t.value === ';'));
  let formatted = sql;
  try { formatted = format(sql, { language: 'sql', keywordCase: 'upper', tabWidth: 2 }); } catch { /* ignore */ }

  const analysis: QueryAnalysis = {
    original, formatted, statementType: 'UNKNOWN', summary: '', tables: [], selectColumns: [], selectStar: false, distinct: false,
    conditions: [], groupBy: [], orderBy: [], ctes: [], subqueryCount: 0, maxDepth: 0, aggregates: [], windowFunctions: [],
    setOperations: [], parameters: [], explanation: [], issues: [], rewriteNotes: [], indexSuggestions: [],
    complexity: { score: 0, label: 'Simple', factors: [] },
  };
  if (tokens.length === 0) { analysis.parseError = 'No SQL found. Paste a query to analyze it.'; return analysis; }

  const issues: Issue[] = [];
  const add = (i: Issue) => { if (!issues.some((x) => x.id === i.id)) issues.push(i); };

  // parameters
  analysis.parameters = Array.from(new Set(tokens.filter((t) => t.type === 'param').map((t) => t.value)));
  analysis.maxDepth = Math.max(0, ...tokens.map((t) => t.depth));
  analysis.subqueryCount = tokens.filter((t, i) => isKw(t, 'SELECT') && i > 0 && t.depth > 0).length;
  analysis.aggregates = Array.from(new Set(tokens.filter((t) => t.type === 'function' && AGGREGATES.has(t.upper)).map((t) => t.upper)));
  analysis.windowFunctions = Array.from(new Set(tokens.filter((t, i) => (t.type === 'function' && WINDOW_FUNCS.has(t.upper)) || (isKw(t, 'OVER') && tokens[i + 1]?.value === '(')).map((t) => (t.upper === 'OVER' ? 'OVER()' : t.upper))));

  // CTEs
  let mainTokens = tokens;
  let baseDepth = 0;
  let idx = 0;
  if (isKw(tokens[0], 'WITH')) {
    idx = 1;
    if (isKw(tokens[idx], 'RECURSIVE')) idx++;
    // loop: name [(cols)] AS ( ... ) ,
    while (idx < tokens.length) {
      const nameTok = tokens[idx];
      if (!nameTok || nameTok.type === 'keyword' && !['MATERIALIZED'].includes(nameTok.upper) && nameTok.upper !== 'AS') break;
      analysis.ctes.push(unquoteIdent(nameTok.value));
      // advance to AS (
      while (idx < tokens.length && !isKw(tokens[idx], 'AS')) idx++;
      idx++; // AS
      while (idx < tokens.length && tokens[idx].value !== '(') idx++;
      // skip to matching close
      const openDepth = tokens[idx]?.depth;
      idx++;
      while (idx < tokens.length && !(tokens[idx].value === ')' && tokens[idx].depth === openDepth)) idx++;
      idx++;
      if (tokens[idx]?.value === ',') { idx++; continue; }
      break;
    }
    mainTokens = tokens.slice(idx);
  }

  // Set operations
  const setOps: string[] = [];
  const parts = splitTopLevel(mainTokens, baseDepth, (t) => isKw(t, 'UNION', 'INTERSECT', 'EXCEPT'));
  if (parts.length > 1) {
    for (let i = 0; i < mainTokens.length; i++) {
      const t = mainTokens[i];
      if (t.depth === baseDepth && isKw(t, 'UNION', 'INTERSECT', 'EXCEPT')) {
        const all = isKw(mainTokens[i + 1], 'ALL');
        setOps.push(all ? `${t.upper} ALL` : t.upper);
      }
    }
    // remove leading ALL tokens
    for (let i = 1; i < parts.length; i++) if (isKw(parts[i][0], 'ALL')) parts[i] = parts[i].slice(1);
  }
  analysis.setOperations = setOps;
  let primary = parts[0];
  // unwrap parentheses around a whole select
  while (primary.length > 2 && primary[0].value === '(' && primary[primary.length - 1].value === ')' && primary[0].depth === baseDepth && isKw(primary[1], 'SELECT')) {
    primary = primary.slice(1, -1); baseDepth++;
  }

  const first = primary[0];
  const stype = first?.upper ?? 'UNKNOWN';
  const explanation: ExplanationStep[] = [];
  let order = 1;

  if (analysis.ctes.length) {
    explanation.push({ order: order++, clause: 'WITH', title: `Define ${analysis.ctes.length === 1 ? 'a temporary named result' : analysis.ctes.length + ' temporary named results'} (CTE)`, details: analysis.ctes.map((c) => `\`${c}\` is computed first and can be referenced like a table in the main query.`) });
    if (isKw(tokens[1], 'RECURSIVE')) explanation[explanation.length - 1].details.push('The CTE is RECURSIVE: it references itself to walk hierarchical data (trees, graphs) until no new rows are produced.');
  }

  // ===================== SELECT =====================
  if (stype === 'SELECT' || stype === 'VALUES' || (stype === '(' && isKw(primary[1], 'SELECT'))) {
    analysis.statementType = 'SELECT';
    const p = splitSelect(primary, baseDepth);
    // select list
    let selTokens = p.selectTokens;
    if (isKw(selTokens[0], 'DISTINCT')) { analysis.distinct = true; selTokens = selTokens.slice(1); }
    if (isKw(selTokens[0], 'ALL')) selTokens = selTokens.slice(1);
    if (isKw(selTokens[0], 'TOP')) { analysis.limit = selTokens[1]?.value; selTokens = selTokens.slice(2); }
    analysis.selectColumns = splitList(selTokens, baseDepth);
    analysis.selectStar = analysis.selectColumns.some((c) => c === '*' || /(^|\.)\*$/.test(c));
    // aggregates that belong to THIS query level (not CTEs / subqueries)
    const levelAggregates = Array.from(new Set(primary.filter((t) => t.depth === baseDepth && t.type === 'function' && AGGREGATES.has(t.upper)).map((t) => t.upper)));
    analysis.aggregates = levelAggregates.length ? levelAggregates : analysis.aggregates.filter(() => false);
    const allAggregates = Array.from(new Set(tokens.filter((t) => t.type === 'function' && AGGREGATES.has(t.upper)).map((t) => t.upper)));
    analysis.tables = parseFrom(p.fromTokens, baseDepth);
    analysis.conditions = parseWhere(p.whereTokens, baseDepth);
    analysis.whereText = p.whereTokens.length ? joinTokens(p.whereTokens) : undefined;
    analysis.groupBy = splitList(p.groupTokens, baseDepth);
    analysis.having = p.havingTokens.length ? joinTokens(p.havingTokens) : undefined;
    analysis.orderBy = splitList(p.orderTokens, baseDepth).map((e) => {
      const m = e.match(/^(.*?)\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?$/i);
      return m ? { expr: m[1], dir: m[2].toUpperCase() } : { expr: e, dir: 'ASC' };
    });
    if (p.limitTokens.length) {
      const lim = joinTokens(p.limitTokens);
      const m = lim.match(/^(\S+)\s*,\s*(\S+)$/);
      if (m) { analysis.offset = m[1]; analysis.limit = m[2]; } else analysis.limit = lim;
    }
    if (p.offsetTokens.length) analysis.offset = joinTokens(p.offsetTokens).replace(/\s+ROWS?$/i, '');

    // ---- explanation ----
    const t0 = analysis.tables[0];
    if (t0) {
      explanation.push({ order: order++, clause: 'FROM', title: `Start from ${t0.isSubquery ? 'a derived table (subquery)' : `table \`${t0.name}\``}${t0.alias ? ` (aliased as \`${t0.alias}\`)` : ''}`, details: [t0.isSubquery ? 'The inner query is evaluated first and its result set is treated as a table.' : `Every row of \`${t0.name}\` is a candidate at this point.`] });
    } else if (analysis.selectColumns.length) {
      explanation.push({ order: order++, clause: 'FROM', title: 'No table involved', details: ['This query computes expressions without reading any table.'] });
    }
    for (const t of analysis.tables.slice(1)) {
      const details = [describeJoin(t.joinType) + '.'];
      if (t.condition) details.push(`Rows are matched using: \`${t.condition}\`.`);
      else if (t.joinType !== 'CROSS JOIN' && t.joinType !== 'NATURAL JOIN' && t.joinType !== 'COMMA') details.push('⚠ No join condition found — this produces a cartesian product.');
      explanation.push({ order: order++, clause: t.joinType === 'COMMA' ? 'JOIN' : t.joinType, title: `${t.joinType === 'COMMA' ? 'Combine with' : t.joinType.replace(' JOIN', ' join with')} ${t.isSubquery ? 'a subquery' : `\`${t.name}\``}${t.alias ? ` as \`${t.alias}\`` : ''}`, details });
    }
    if (analysis.conditions.length) {
      const details = analysis.conditions.map((c, i) => `${i === 0 ? 'Keep rows where' : c.connector === 'OR' ? 'OR where' : 'AND where'} ${conditionToEnglish(c)}.`);
      if (analysis.conditions.some((c) => c.hasSubquery)) details.push('One or more conditions depend on a subquery, which may be evaluated once (uncorrelated) or once per row (correlated).');
      explanation.push({ order: order++, clause: 'WHERE', title: `Filter rows (${analysis.conditions.length} condition${analysis.conditions.length > 1 ? 's' : ''})`, details });
    }
    if (analysis.groupBy.length) {
      const details = [`Rows sharing the same value of ${analysis.groupBy.map((g) => `\`${g}\``).join(', ')} are collapsed into a single group.`];
      if (analysis.aggregates.length) details.push(`Aggregates computed per group: ${analysis.aggregates.join(', ')}.`);
      explanation.push({ order: order++, clause: 'GROUP BY', title: `Group rows by ${analysis.groupBy.join(', ')}`, details });
    } else if (analysis.aggregates.length && analysis.tables.length) {
      explanation.push({ order: order++, clause: 'AGGREGATE', title: 'Collapse all rows into a single aggregate row', details: [`Without GROUP BY, ${analysis.aggregates.join(', ')} summarise the whole filtered set into one row.`] });
    }
    if (analysis.having) {
      explanation.push({ order: order++, clause: 'HAVING', title: 'Filter groups', details: [`After grouping, only groups satisfying \`${analysis.having}\` survive. Unlike WHERE, HAVING can reference aggregates.`] });
    }
    if (analysis.windowFunctions.length) {
      explanation.push({ order: order++, clause: 'WINDOW', title: 'Compute window functions', details: [`${analysis.windowFunctions.join(', ')} are evaluated over "windows" of rows (defined by PARTITION BY / ORDER BY) without collapsing rows.`] });
    }
    {
      const details: string[] = [];
      if (analysis.selectStar) details.push('`*` returns every column of the involved tables.');
      const nonStar = analysis.selectColumns.filter((c) => c !== '*');
      if (nonStar.length) details.push(`Output columns: ${nonStar.map((c) => `\`${c}\``).join(', ')}.`);
      if (analysis.distinct) details.push('DISTINCT removes duplicate output rows (this requires a sort or hash over the whole result).');
      explanation.push({ order: order++, clause: 'SELECT', title: `Project ${analysis.selectStar ? 'all columns' : analysis.selectColumns.length + ' column' + (analysis.selectColumns.length !== 1 ? 's' : '')}${analysis.distinct ? ' (distinct)' : ''}`, details });
    }
    if (setOps.length) {
      explanation.push({ order: order++, clause: 'SET', title: `Combine ${parts.length} result sets with ${Array.from(new Set(setOps)).join(', ')}`, details: setOps.map((s) => s.includes('ALL') ? `${s}: append results, keeping duplicates (cheap).` : s === 'UNION' ? 'UNION: append results and remove duplicate rows (requires a sort/hash of everything).' : s === 'INTERSECT' ? 'INTERSECT: keep only rows present in both sets.' : 'EXCEPT: keep rows of the first set not present in the second.') });
    }
    if (analysis.orderBy.length) {
      explanation.push({ order: order++, clause: 'ORDER BY', title: 'Sort the result', details: analysis.orderBy.map((o, i) => `${i === 0 ? 'Primarily' : 'then'} by \`${o.expr}\` ${o.dir === 'DESC' ? 'descending (largest / latest first)' : 'ascending (smallest first)'}.`) });
    }
    if (analysis.limit || analysis.offset) {
      const d: string[] = [];
      if (analysis.offset) d.push(`Skip the first ${analysis.offset} rows.`);
      if (analysis.limit) d.push(`Return at most ${analysis.limit} rows.`);
      explanation.push({ order: order++, clause: 'LIMIT', title: 'Restrict the number of rows returned', details: d });
    }

    // ---- summary ----
    const tblNames = analysis.tables.filter((t) => !t.isSubquery).map((t) => t.name);
    analysis.summary = `Reads ${tblNames.length ? tblNames.map((n) => `\`${n}\``).join(', ') : 'no tables'}${analysis.conditions.length ? `, filters on ${analysis.conditions.length} condition${analysis.conditions.length > 1 ? 's' : ''}` : ''}${analysis.groupBy.length ? `, groups by ${analysis.groupBy.join(', ')}` : ''}${allAggregates.length ? `, aggregates with ${allAggregates.join('/')}` : ''}${analysis.windowFunctions.length ? `, ranks with window functions` : ''}${setOps.length ? `, combines ${parts.length} result sets via ${Array.from(new Set(setOps)).join('/')}` : ''}${analysis.orderBy.length ? `, sorts by ${analysis.orderBy.map((o) => o.expr).join(', ')}` : ''}${analysis.limit ? `, returns up to ${analysis.limit} rows` : ''}.`;

    // ---- issues ----
    if (analysis.selectStar) add({ id: 'select-star', severity: analysis.tables.length > 1 ? 'high' : 'medium', category: 'performance', title: 'SELECT * fetches every column', description: analysis.tables.length > 1 ? 'With joins, `*` pulls all columns from every table, including duplicates of the join keys. That inflates network I/O, prevents covering-index usage, and breaks consumers if columns are added.' : 'Fetching all columns prevents the database from answering the query from an index alone (covering index) and sends unused data over the wire.', suggestion: 'List only the columns you actually need, e.g. `SELECT u.id, u.name, o.total`.' });
    const commaJoins = analysis.tables.filter((t) => t.joinType === 'COMMA');
    if (commaJoins.length) add({ id: 'implicit-join', severity: 'medium', category: 'readability', title: 'Implicit comma join (old-style syntax)', description: 'Tables listed with commas are joined as a cartesian product and filtered later in WHERE. It is easy to forget a join predicate, and intent is unclear.', suggestion: 'Use explicit `JOIN ... ON ...` syntax so join conditions live next to the tables they connect.' });
    const noCond = analysis.tables.slice(1).filter((t) => !t.condition && !['CROSS JOIN', 'NATURAL JOIN', 'COMMA'].includes(t.joinType));
    if (noCond.length) add({ id: 'join-no-on', severity: 'critical', category: 'correctness', title: 'JOIN without ON condition', description: `\`${noCond.map((t) => t.name).join('`, `')}\` is joined without a condition. Every row pairs with every row — result size explodes multiplicatively.`, suggestion: 'Add an `ON` clause matching the foreign key, or make the intent explicit with `CROSS JOIN`.' });
    if (analysis.tables.some((t) => t.joinType === 'CROSS JOIN')) add({ id: 'cross-join', severity: 'medium', category: 'performance', title: 'CROSS JOIN produces a cartesian product', description: 'Rows = rows(A) × rows(B). Make sure this is intentional and that both sides are small.' });
    if (analysis.tables.some((t) => t.joinType === 'NATURAL JOIN')) add({ id: 'natural-join', severity: 'medium', category: 'correctness', title: 'NATURAL JOIN is fragile', description: 'It joins on every same-named column. Adding a column like `created_at` to both tables silently changes the result.', suggestion: 'Use `JOIN ... ON` or `USING (col)` with explicit columns.' });
    if (commaJoins.length && analysis.conditions.length === 0) add({ id: 'comma-no-where', severity: 'critical', category: 'correctness', title: 'Cartesian product: comma join with no WHERE', description: 'No condition links the tables, so every combination of rows is returned.', suggestion: 'Add a join condition.' });
    if (analysis.tables.length > 1 && analysis.tables.some((t) => !t.alias && !t.isSubquery) && analysis.tables.filter((t) => !t.alias).length > 1) add({ id: 'no-alias', severity: 'low', category: 'readability', title: 'Tables without aliases in a multi-table query', description: 'Short aliases make column references unambiguous and the query easier to read.', suggestion: 'e.g. `FROM orders o JOIN customers c ON o.customer_id = c.id`.' });
    if (analysis.tables.length > 5) add({ id: 'many-joins', severity: 'low', category: 'performance', title: `${analysis.tables.length} tables joined`, description: 'The optimizer has to consider many join orders; statistics errors compound. Consider whether all joins are needed for this result, or pre-aggregate in a CTE.' });

    // WHERE conditions
    const flatConds = flattenConditions(analysis.conditions);
    for (const c of flatConds) {
      if (c.op === 'GROUP') continue;
      const v = (c.value ?? '').trim();
      if (c.op && ['=', '<>', '!='].includes(c.op) && /^NULL$/i.test(v)) add({ id: 'null-compare', severity: 'critical', category: 'correctness', title: `Comparison with NULL using ${c.op}`, description: '`= NULL` and `<> NULL` are never true in SQL (NULL is unknown). This condition silently filters out every row.', suggestion: `Use \`IS NULL\` / \`IS NOT NULL\` instead.`, autoFixed: true });
      if (c.op && ['LIKE', 'ILIKE', 'NOT LIKE'].includes(c.op) && /^'%/.test(v)) add({ id: 'leading-wildcard', severity: 'high', category: 'performance', title: 'Leading wildcard in LIKE pattern', description: `\`${c.raw}\` cannot use a regular B-tree index because the beginning of the string is unknown — the database scans every row.`, suggestion: 'Anchor the pattern (`\'abc%\'`), or use a full-text index / trigram index (pg_trgm) for substring search.' });
      if (c.op && ['LIKE', 'ILIKE'].includes(c.op) && /^'[^%_]*'$/.test(v)) add({ id: 'like-no-wildcard', severity: 'low', category: 'readability', title: 'LIKE without wildcards', description: `\`${c.raw}\` has no % or _ so it behaves like an equality test but may be planned less efficiently.`, suggestion: 'Use `=` for exact matches.', autoFixed: true });
      if (c.wrappedColumn && c.wrappedColumn !== 'ARITHMETIC' && c.op && !['EXISTS', 'NOT EXISTS'].includes(c.op)) {
        const fn = c.wrappedColumn;
        const isDate = ['YEAR', 'MONTH', 'DAY', 'DATE', 'DATE_TRUNC', 'EXTRACT', 'DATEPART', 'STRFTIME', 'TO_CHAR', 'CONVERT'].includes(fn);
        const isCase = ['LOWER', 'UPPER', 'LCASE', 'UCASE'].includes(fn);
        add({ id: `fn-on-column-${fn}`, severity: 'high', category: 'performance', title: `Function ${fn}() applied to a column in WHERE (non-sargable)`, description: `\`${c.raw}\`: because the column is transformed before comparison, an index on \`${c.column}\` cannot be used — every row must be evaluated.`, suggestion: isDate ? `Rewrite as a range: \`${c.column} >= '2024-01-01' AND ${c.column} < '2025-01-01'\`.` : isCase ? `Store a normalised copy, use a case-insensitive collation, or create a functional/expression index on \`${fn}(${c.column})\`.` : `Move the computation to the constant side of the comparison, or create an expression index on \`${fn}(${c.column})\`.`, autoFixed: fn === 'YEAR' && c.op === '=' && /^\d{4}$/.test(v) });
      }
      if (c.wrappedColumn === 'ARITHMETIC') add({ id: 'arith-on-column', severity: 'high', category: 'performance', title: 'Arithmetic on a column in WHERE (non-sargable)', description: `\`${c.raw}\`: the column is modified before comparison so indexes cannot be used.`, suggestion: 'Move the math to the other side: `price > 100 / 1.2` instead of `price * 1.2 > 100`.' });
      if (c.op === 'NOT IN' && c.hasSubquery) add({ id: 'not-in-subquery', severity: 'high', category: 'correctness', title: 'NOT IN with a subquery', description: 'If the subquery returns a single NULL, `NOT IN` yields no rows at all. It also tends to plan poorly on large sets.', suggestion: 'Use `NOT EXISTS (SELECT 1 FROM ... WHERE ... = outer.col)` — NULL-safe and usually faster.' , autoFixed: false });
      if (c.op === 'IN' && c.hasSubquery) add({ id: 'in-subquery', severity: 'info', category: 'performance', title: 'IN (subquery)', description: 'Modern optimizers usually convert this to a semi-join, but on some engines (older MySQL) it is re-executed per row.', suggestion: 'If slow, rewrite as `JOIN` or `EXISTS`.' });
      if (c.op === 'IN' && !c.hasSubquery) {
        const count = v.split(',').length;
        if (count > 50) add({ id: 'large-in-list', severity: 'medium', category: 'performance', title: `IN list with ${count} values`, description: 'Very long IN lists produce large plans and can hit parameter limits.', suggestion: 'Load the values into a temporary table / VALUES CTE and JOIN against it, or pass an array parameter.' });
      }
      if (c.op && ['=', '<>', '!=', '>', '<', '>=', '<='].includes(c.op) && /^'\d+(\.\d+)?'$/.test(v) && c.column && /(^|_)(id|count|qty|quantity|amount|num|number|age|year)$/i.test(c.column)) add({ id: 'implicit-cast', severity: 'medium', category: 'performance', title: 'Numeric column compared to a string literal', description: `\`${c.raw}\` — if \`${c.column}\` is numeric the database must convert one side, which can defeat the index or produce surprising matches.`, suggestion: `Compare with a number: \`${c.column} ${c.op} ${v.replace(/'/g, '')}\`.` });
      if (c.op && ['<>', '!='].includes(c.op) && !c.hasSubquery) add({ id: 'not-equal', severity: 'info', category: 'performance', title: 'Inequality (<>) predicates rarely use indexes', description: `\`${c.raw}\` usually matches most rows, so the planner will prefer a scan. Fine if selective; otherwise flip the logic to a positive match.` });
      if (/^1\s*=\s*1$/.test(c.raw)) add({ id: 'one-eq-one', severity: 'info', category: 'readability', title: '`1 = 1` placeholder predicate', description: 'Harmless — optimizers remove it — but it usually signals dynamically-concatenated SQL. Make sure user input is parameterised.' });
      if (/\bOR\s+1\s*=\s*1\b|'\s*OR\s*'|--\s*$/i.test(c.raw)) add({ id: 'injection-pattern', severity: 'critical', category: 'security', title: 'Suspicious pattern resembling SQL injection', description: `\`${c.raw}\` contains a tautology or comment terminator typical of injection payloads.`, suggestion: 'Never concatenate user input into SQL; use bound parameters.' });
      if (c.op && c.op.endsWith('NULL') === false && c.op !== 'EXISTS' && c.op !== 'NOT EXISTS' && /^'\s*'$/.test(v) === false && c.hasSubquery && /SELECT\s+\*/i.test(v) && (c.op === 'EXISTS' || c.op === 'NOT EXISTS')) { /* handled below */ }
    }
    const orLists: Condition[][] = [];
    if (analysis.conditions.some((c) => c.connector === 'OR')) orLists.push(analysis.conditions);
    for (const c of flatConds) if (c.op === 'GROUP' && c.groupOp === 'OR' && c.children) orLists.push(c.children);
    for (const list of orLists) {
      const eqCols = list.filter((c) => c.op === '=' && c.column && !c.hasSubquery);
      const byCol = new Map<string, number>();
      eqCols.forEach((c) => byCol.set(c.column!, (byCol.get(c.column!) ?? 0) + 1));
      const repeated = Array.from(byCol.entries()).filter(([, n]) => n > 1);
      if (repeated.length) add({ id: 'or-to-in', severity: 'low', category: 'readability', title: 'Chain of OR equality checks on the same column', description: `\`${repeated.map(([c]) => c).join('`, `')}\` is compared to several values with OR.`, suggestion: 'Use `IN (...)` — shorter and often planned better.', autoFixed: true });
      else add({ id: 'or-conditions', severity: 'info', category: 'performance', title: 'OR conditions across different columns', description: 'OR across columns often forces a full scan because a single index cannot serve both branches.', suggestion: 'Consider a `UNION ALL` of two indexed queries, or a bitmap index scan (PostgreSQL does this automatically when both columns are indexed).' });
    }
    if (analysis.conditions.some((c) => c.op === 'EXISTS' || c.op === 'NOT EXISTS') && analysis.conditions.some((c) => /^\(\s*SELECT\s+\*/i.test(c.value ?? ''))) add({ id: 'exists-star', severity: 'info', category: 'readability', title: 'EXISTS (SELECT *)', description: 'Fine for the planner, but `SELECT 1` communicates that no columns are needed.' });

    // scalar subqueries in select list
    const scalarSub = analysis.selectColumns.filter((c) => /^\(\s*SELECT/i.test(c) || /\(\s*SELECT\b/i.test(c));
    if (scalarSub.length) add({ id: 'scalar-subquery', severity: 'high', category: 'performance', title: `${scalarSub.length} subquer${scalarSub.length > 1 ? 'ies' : 'y'} in the SELECT list`, description: 'Scalar subqueries are frequently executed once per output row (N+1 pattern), which is quadratic on large results.', suggestion: 'Rewrite as a `LEFT JOIN` to a pre-aggregated derived table / CTE (`GROUP BY` the key once) and select from it.' });
    if (analysis.distinct && analysis.groupBy.length) add({ id: 'distinct-group', severity: 'low', category: 'performance', title: 'DISTINCT is redundant with GROUP BY', description: 'GROUP BY already yields one row per group; DISTINCT adds a second de-duplication pass.', suggestion: 'Remove DISTINCT.', autoFixed: true });
    else if (analysis.distinct && analysis.tables.length > 1) add({ id: 'distinct-join', severity: 'medium', category: 'correctness', title: 'DISTINCT used with JOINs', description: 'DISTINCT after a join often papers over a fan-out (one-to-many join producing duplicates). It hides the root cause and costs a full sort/hash.', suggestion: 'Check whether an `EXISTS` semi-join or pre-aggregation expresses the intent without duplicates.' });
    if (analysis.aggregates.length && !analysis.groupBy.length) {
      const nonAgg = analysis.selectColumns.filter((c) => !new RegExp(`\\b(${Array.from(AGGREGATES).join('|')})\\s*\\(`, 'i').test(c) && c !== '*' && !/^\d+$|^'.*'$/.test(c));
      if (nonAgg.length) add({ id: 'agg-without-group', severity: 'high', category: 'correctness', title: 'Mixing aggregates with plain columns without GROUP BY', description: `Columns ${nonAgg.map((c) => `\`${c}\``).join(', ')} are not aggregated. Most databases reject this; MySQL (without ONLY_FULL_GROUP_BY) returns an arbitrary value.`, suggestion: 'Add the plain columns to GROUP BY or wrap them in an aggregate.' });
    }
    if (analysis.aggregates.includes('COUNT') && /COUNT\s*\(\s*DISTINCT/i.test(sql)) add({ id: 'count-distinct', severity: 'info', category: 'performance', title: 'COUNT(DISTINCT ...)', description: 'Requires de-duplicating all values, which is memory-heavy at scale. Consider approximate counting (HyperLogLog / APPROX_COUNT_DISTINCT) for dashboards.' });
    if (analysis.having && analysis.groupBy.length) {
      const aggRe = new RegExp(`\\b(${Array.from(AGGREGATES).join('|')})\\s*\\(`, 'i');
      const parts = analysis.having.split(/\s+AND\s+/i);
      const movable = parts.filter((p) => !aggRe.test(p));
      if (movable.length) add({ id: 'having-to-where', severity: 'medium', category: 'performance', title: 'HAVING condition without aggregate', description: `\`${movable.join(' AND ')}\` filters rows after grouping, so every row is grouped first and thrown away later.`, suggestion: 'Move non-aggregate conditions to WHERE so rows are eliminated before the expensive grouping step.' });
    }
    if (analysis.orderBy.length) {
      if (analysis.orderBy.some((o) => /^(RAND|RANDOM|NEWID)\s*\(/i.test(o.expr))) add({ id: 'order-random', severity: 'high', category: 'performance', title: 'ORDER BY RANDOM()', description: 'Assigns a random number to every row and sorts them all — O(n log n) on the entire table just to pick a few rows.', suggestion: 'Use `TABLESAMPLE`, pick a random id range, or `WHERE id >= (random id)` with an index.' });
      if (analysis.orderBy.some((o) => /^\d+$/.test(o.expr))) add({ id: 'order-ordinal', severity: 'low', category: 'readability', title: 'ORDER BY column position', description: 'Ordinal references break silently when the SELECT list changes.', suggestion: 'Order by the column name or alias.' });
      if (!analysis.limit && !analysis.aggregates.length) add({ id: 'order-no-limit', severity: 'info', category: 'performance', title: 'ORDER BY without LIMIT', description: 'The whole result must be sorted. Fine for small results — for large ones ensure an index matches the sort order so the sort can be skipped.' });
      const orderCols = analysis.orderBy.map((o) => o.expr.split('.').pop()!);
      if (analysis.selectColumns.length && !analysis.selectStar) {
        const missing = orderCols.filter((oc) => /^[A-Za-z_]\w*$/.test(oc) && !analysis.selectColumns.some((sc) => sc.split(/\s+AS\s+|\s+/i).pop()!.split('.').pop() === oc || sc.split('.').pop() === oc));
        if (missing.length && analysis.distinct) add({ id: 'order-not-selected', severity: 'high', category: 'correctness', title: 'ORDER BY column not in SELECT DISTINCT list', description: `Ordering by \`${missing.join('`, `')}\` with DISTINCT is an error in PostgreSQL/SQL Server (the expression must appear in the select list).` });
      }
    }
    if (analysis.limit && !analysis.orderBy.length && analysis.tables.length) add({ id: 'limit-no-order', severity: 'medium', category: 'correctness', title: 'LIMIT without ORDER BY is non-deterministic', description: 'Without an ORDER BY, the database may return a different subset of rows on each execution or after a plan change.', suggestion: 'Add `ORDER BY <unique column>` (e.g. the primary key) to make pagination stable.' });
    if (analysis.offset && Number(analysis.offset) >= 1000) add({ id: 'large-offset', severity: 'high', category: 'performance', title: `Large OFFSET (${analysis.offset})`, description: 'The database still reads and discards all skipped rows — page 500 is 500× more expensive than page 1.', suggestion: 'Use keyset pagination: `WHERE (created_at, id) < (:last_created_at, :last_id) ORDER BY created_at DESC, id DESC LIMIT n`.' });
    if (setOps.includes('UNION')) add({ id: 'union-all', severity: 'medium', category: 'performance', title: 'UNION removes duplicates (sort + dedupe)', description: 'UNION de-duplicates across all branches, which requires sorting/hashing the entire combined set.', suggestion: 'If duplicates are impossible or acceptable, use `UNION ALL` — it just appends.' });
    if (analysis.maxDepth >= 3 && analysis.subqueryCount >= 2) add({ id: 'deep-nesting', severity: 'low', category: 'readability', title: `Deeply nested subqueries (${analysis.subqueryCount} subqueries, depth ${analysis.maxDepth})`, description: 'Hard to read and reason about; hard for the optimizer too.', suggestion: 'Extract each level into a named CTE (`WITH step1 AS (...), step2 AS (...)`).' });
    if (analysis.tables.some((t) => t.isSubquery)) add({ id: 'derived-table', severity: 'info', category: 'readability', title: 'Derived table in FROM', description: 'Inline subqueries in FROM are fine, but a CTE with a descriptive name usually reads better and can be reused.' });
    if (analysis.tables.some((t) => t.joinType.startsWith('RIGHT'))) add({ id: 'right-join', severity: 'low', category: 'readability', title: 'RIGHT JOIN', description: 'Most people read joins left-to-right; RIGHT JOIN can always be rewritten as a LEFT JOIN by swapping tables.' });
    if (analysis.windowFunctions.length && analysis.tables.length && !analysis.conditions.length) add({ id: 'window-no-filter', severity: 'info', category: 'performance', title: 'Window functions over an unfiltered table', description: 'Window functions materialise and sort their partitions; without a WHERE clause that is the entire table.' });
    if (/\bLIKE\s+'%[^%]*%'/i.test(sql)) add({ id: 'double-wildcard', severity: 'info', category: 'performance', title: 'Substring search with %term%', description: 'Consider a full-text index (PostgreSQL tsvector / GIN, MySQL FULLTEXT) for search features.' });
    if (analysis.parameters.length) add({ id: 'params-good', severity: 'good', category: 'security', title: 'Uses bound parameters', description: `Parameters ${analysis.parameters.join(', ')} keep data out of the SQL text — safe from injection and plan-cache friendly.` });
    if (!issues.some((i) => i.severity === 'critical' || i.severity === 'high') && analysis.conditions.length && analysis.tables.length) add({ id: 'looks-good', severity: 'good', category: 'performance', title: 'No major performance anti-patterns detected', description: 'The query structure is sound. Verify with EXPLAIN that the predicates hit indexes.' });

    // ---- rewrite ----
    analysis.rewritten = buildRewrite(sql, analysis, issues);
    // ---- indexes ----
    analysis.indexSuggestions = suggestIndexes(analysis);
  }
  // ===================== INSERT =====================
  else if (stype === 'INSERT' || stype === 'REPLACE') {
    analysis.statementType = 'INSERT';
    const intoIdx = primary.findIndex((t) => isKw(t, 'INTO'));
    const tblTok = primary[intoIdx + 1];
    const table = tblTok ? unquoteIdent(tblTok.value) : '?';
    analysis.tables = [{ name: table, joinType: 'INTO', isSubquery: false }];
    let afterTbl = intoIdx + 2;
    if (primary[afterTbl]?.value === '.') afterTbl += 2; // schema.table
    if (isKw(primary[afterTbl], 'AS')) afterTbl += 2; else if (primary[afterTbl]?.type === 'identifier') afterTbl += 1;
    const hasColList = primary[afterTbl]?.value === '(';
    const valuesIdx = primary.findIndex((t) => t.depth === baseDepth && isKw(t, 'VALUES'));
    const selectIdx = primary.findIndex((t) => t.depth === baseDepth && isKw(t, 'SELECT'));
    let rowCount = 0;
    if (valuesIdx >= 0) rowCount = primary.slice(valuesIdx).filter((t) => t.value === '(' && t.depth === baseDepth).length;
    const onConflict = primary.some((t) => isKw(t, 'CONFLICT', 'DUPLICATE'));
    const returning = primary.some((t) => isKw(t, 'RETURNING'));
    explanation.push({ order: order++, clause: 'INSERT', title: `Insert into \`${table}\``, details: [selectIdx >= 0 && valuesIdx < 0 ? 'Rows come from a SELECT query (INSERT ... SELECT) — as many rows as the query returns.' : `${rowCount} row${rowCount !== 1 ? 's' : ''} supplied literally via VALUES.`] });
    if (hasColList) explanation.push({ order: order++, clause: 'COLUMNS', title: 'Explicit column list', details: ['Values are mapped to the named columns; unspecified columns receive their DEFAULT or NULL.'] });
    if (onConflict) explanation.push({ order: order++, clause: 'UPSERT', title: 'Conflict handling', details: ['If a unique key already exists, the ON CONFLICT / ON DUPLICATE KEY rule decides whether to skip or update the existing row (upsert).'] });
    if (returning) explanation.push({ order: order++, clause: 'RETURNING', title: 'Return inserted rows', details: ['The inserted rows (e.g. generated ids) are sent back to the client without a second query.'] });
    analysis.summary = `Inserts ${selectIdx >= 0 && valuesIdx < 0 ? 'the result of a SELECT' : `${rowCount} row${rowCount !== 1 ? 's' : ''}`} into \`${table}\`${onConflict ? ' with upsert semantics' : ''}.`;
    if (!hasColList) add({ id: 'insert-no-columns', severity: 'medium', category: 'correctness', title: 'INSERT without a column list', description: 'Values are matched by table column order. Adding or reordering columns will silently corrupt data or fail.', suggestion: `Write \`INSERT INTO ${table} (col1, col2, ...) VALUES (...)\`.` });
    if (rowCount > 1000) add({ id: 'huge-insert', severity: 'medium', category: 'performance', title: `${rowCount} rows in one statement`, description: 'Very large single statements can exceed packet limits and hold locks for long. Batch in chunks of ~500–1000 or use bulk loading (COPY / LOAD DATA).' });
    if (rowCount === 1 && !analysis.parameters.length) add({ id: 'single-insert', severity: 'info', category: 'performance', title: 'Single-row insert with literal values', description: 'If this runs in a loop, batch multiple rows per statement (multi-row VALUES) — it is often 10× faster.' });
    if (analysis.parameters.length) add({ id: 'params-good', severity: 'good', category: 'security', title: 'Uses bound parameters', description: 'Values are passed as parameters — safe from injection.' });
    else if (primary.some((t) => t.type === 'string')) add({ id: 'literal-values', severity: 'low', category: 'security', title: 'Literal string values in the statement', description: 'If any of these come from user input, use parameters instead of string concatenation.' });
  }
  // ===================== UPDATE =====================
  else if (stype === 'UPDATE') {
    analysis.statementType = 'UPDATE';
    const tblTok = primary[1];
    const table = tblTok ? unquoteIdent(tblTok.value) : '?';
    analysis.tables = [{ name: table, joinType: 'UPDATE', isSubquery: false }];
    const setIdx = primary.findIndex((t) => t.depth === baseDepth && isKw(t, 'SET'));
    const whereIdx = primary.findIndex((t) => t.depth === baseDepth && isKw(t, 'WHERE'));
    const setTokens = primary.slice(setIdx + 1, whereIdx >= 0 ? whereIdx : undefined);
    const assignments = splitList(setTokens, baseDepth);
    if (whereIdx >= 0) { analysis.conditions = parseWhere(primary.slice(whereIdx + 1), baseDepth); analysis.whereText = joinTokens(primary.slice(whereIdx + 1)); }
    explanation.push({ order: order++, clause: 'UPDATE', title: `Target table \`${table}\``, details: ['Rows of this table will be modified in place.'] });
    if (analysis.conditions.length) explanation.push({ order: order++, clause: 'WHERE', title: 'Select rows to change', details: analysis.conditions.map((c, i) => `${i === 0 ? 'Only rows where' : c.connector === 'OR' ? 'OR where' : 'AND where'} ${conditionToEnglish(c)}.`) });
    else explanation.push({ order: order++, clause: 'WHERE', title: 'No WHERE — every row is affected', details: ['⚠ Without a filter, the update is applied to the entire table.'] });
    explanation.push({ order: order++, clause: 'SET', title: `Apply ${assignments.length} assignment${assignments.length !== 1 ? 's' : ''}`, details: assignments.map((a) => `Set \`${a}\`.`) });
    analysis.summary = `Updates ${assignments.length} column${assignments.length !== 1 ? 's' : ''} in \`${table}\`${analysis.conditions.length ? ` for rows matching ${analysis.conditions.length} condition${analysis.conditions.length > 1 ? 's' : ''}` : ' for ALL rows'}.`;
    if (!analysis.conditions.length) add({ id: 'update-no-where', severity: 'critical', category: 'safety', title: 'UPDATE without WHERE affects every row', description: 'Every row in the table will be overwritten. This is one of the most common catastrophic mistakes.', suggestion: 'Add a WHERE clause; when in doubt run the equivalent SELECT first and wrap in a transaction.' });
    for (const c of analysis.conditions) {
      if (c.op && ['=', '<>', '!='].includes(c.op) && /^NULL$/i.test(c.value ?? '')) add({ id: 'null-compare', severity: 'critical', category: 'correctness', title: `Comparison with NULL using ${c.op}`, description: 'Never true — no rows will be updated.', suggestion: 'Use IS NULL / IS NOT NULL.', autoFixed: true });
      if (c.wrappedColumn) add({ id: 'fn-on-column', severity: 'high', category: 'performance', title: 'Function on column in WHERE', description: `\`${c.raw}\` prevents index usage when locating the rows to update.`, suggestion: 'Compare the raw column to a computed constant/range.' });
    }
    if (assignments.some((a) => /=\s*NULL$/i.test(a) === false && /^\w+\s*=\s*\w+\s*$/.test(a) && a.split('=')[0].trim() === a.split('=')[1].trim())) add({ id: 'noop-assign', severity: 'low', category: 'readability', title: 'Column assigned to itself', description: 'A no-op assignment still writes the row (and fires triggers).' });
    if (primary.some((t) => t.depth === baseDepth && isKw(t, 'JOIN', 'FROM'))) add({ id: 'update-join', severity: 'info', category: 'correctness', title: 'UPDATE with JOIN / FROM', description: 'Syntax differs across databases (MySQL `UPDATE a JOIN b`, PostgreSQL `UPDATE a ... FROM b`, SQL Server `UPDATE a ... FROM a JOIN b`). Ensure one source row per target row to avoid nondeterministic results.' });
    if (analysis.parameters.length) add({ id: 'params-good', severity: 'good', category: 'security', title: 'Uses bound parameters', description: 'Values are parameterised — safe from injection.' });
    analysis.rewritten = buildRewrite(sql, analysis, issues);
    analysis.indexSuggestions = suggestIndexes(analysis);
  }
  // ===================== DELETE =====================
  else if (stype === 'DELETE') {
    analysis.statementType = 'DELETE';
    const fromIdx = primary.findIndex((t) => isKw(t, 'FROM'));
    const tblTok = primary[fromIdx + 1];
    const table = tblTok ? unquoteIdent(tblTok.value) : '?';
    analysis.tables = [{ name: table, joinType: 'DELETE', isSubquery: false }];
    const whereIdx = primary.findIndex((t) => t.depth === baseDepth && isKw(t, 'WHERE'));
    if (whereIdx >= 0) { analysis.conditions = parseWhere(primary.slice(whereIdx + 1), baseDepth); analysis.whereText = joinTokens(primary.slice(whereIdx + 1)); }
    explanation.push({ order: order++, clause: 'DELETE', title: `Target table \`${table}\``, details: ['Matching rows are removed permanently (unless inside a transaction that is rolled back).'] });
    if (analysis.conditions.length) explanation.push({ order: order++, clause: 'WHERE', title: 'Select rows to delete', details: analysis.conditions.map((c, i) => `${i === 0 ? 'Only rows where' : c.connector === 'OR' ? 'OR where' : 'AND where'} ${conditionToEnglish(c)}.`) });
    else explanation.push({ order: order++, clause: 'WHERE', title: 'No WHERE — the whole table is emptied', details: ['⚠ All rows will be deleted.'] });
    analysis.summary = `Deletes ${analysis.conditions.length ? 'rows matching ' + analysis.conditions.length + ' condition' + (analysis.conditions.length > 1 ? 's' : '') : 'ALL rows'} from \`${table}\`.`;
    if (!analysis.conditions.length) add({ id: 'delete-no-where', severity: 'critical', category: 'safety', title: 'DELETE without WHERE removes every row', description: 'The entire table is emptied, row by row, with full logging.', suggestion: 'Add a WHERE clause. If emptying the table is intended, `TRUNCATE TABLE` is far faster (but not transactional in all engines).' });
    for (const c of analysis.conditions) {
      if (c.op && ['=', '<>', '!='].includes(c.op) && /^NULL$/i.test(c.value ?? '')) add({ id: 'null-compare', severity: 'critical', category: 'correctness', title: `Comparison with NULL using ${c.op}`, description: 'Never true — no rows will be deleted.', suggestion: 'Use IS NULL / IS NOT NULL.', autoFixed: true });
      if (c.op === 'NOT IN' && c.hasSubquery) add({ id: 'not-in-subquery', severity: 'high', category: 'correctness', title: 'NOT IN with subquery', description: 'A NULL in the subquery result makes the whole predicate unknown — nothing gets deleted.', suggestion: 'Use NOT EXISTS.' });
      if (c.wrappedColumn) add({ id: 'fn-on-column', severity: 'high', category: 'performance', title: 'Function on column in WHERE', description: `\`${c.raw}\` prevents index usage when locating rows.`, suggestion: 'Compare the raw column against a range.' });
    }
    if (analysis.conditions.length && !analysis.limit) add({ id: 'delete-batch', severity: 'info', category: 'performance', title: 'Large deletes should be batched', description: 'If this can match millions of rows, delete in chunks (e.g. by id range or `LIMIT 5000` in a loop) to keep locks and transaction logs small.' });
    analysis.rewritten = buildRewrite(sql, analysis, issues);
    analysis.indexSuggestions = suggestIndexes(analysis);
  }
  // ===================== CREATE TABLE =====================
  else if (stype === 'CREATE' && primary.some((t) => isKw(t, 'TABLE'))) {
    analysis.statementType = 'CREATE TABLE';
    const tblIdx = primary.findIndex((t) => isKw(t, 'TABLE'));
    let k = tblIdx + 1;
    while (isKw(primary[k], 'IF', 'NOT', 'EXISTS')) k++;
    const table = unquoteIdent(primary[k]?.value ?? '?');
    analysis.tables = [{ name: table, joinType: 'CREATE', isSubquery: false }];
    const open = primary.findIndex((t, i) => i > k && t.value === '(');
    const body = primary.slice(open + 1, primary.length - (primary[primary.length - 1].value === ')' ? 1 : 0));
    const defs = splitTopLevel(body, baseDepth + 1, (t) => t.value === ',');
    const columns: { name: string; type: string; flags: string[] }[] = [];
    const constraints: string[] = [];
    for (const d of defs) {
      if (!d.length) continue;
      if (isKw(d[0], 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'KEY', 'INDEX')) { constraints.push(joinTokens(d)); continue; }
      const name = unquoteIdent(d[0].value);
      const typeToks: string[] = [];
      let j = 1;
      while (j < d.length && !isKw(d[j], 'PRIMARY', 'NOT', 'NULL', 'DEFAULT', 'UNIQUE', 'REFERENCES', 'CHECK', 'AUTOINCREMENT', 'AUTO_INCREMENT', 'GENERATED', 'COLLATE')) { typeToks.push(d[j].value); j++; }
      const rest = joinTokens(d.slice(j)).toUpperCase();
      const flags: string[] = [];
      if (/PRIMARY KEY/.test(rest)) flags.push('PK');
      if (/NOT NULL/.test(rest)) flags.push('NOT NULL');
      if (/UNIQUE/.test(rest)) flags.push('UNIQUE');
      if (/REFERENCES/.test(rest)) flags.push('FK');
      if (/DEFAULT/.test(rest)) flags.push('DEFAULT');
      columns.push({ name, type: typeToks.join('').replace(/\(/g, '(').toUpperCase() || 'ANY', flags });
    }
    analysis.selectColumns = columns.map((c) => `${c.name} ${c.type}${c.flags.length ? ' [' + c.flags.join(', ') + ']' : ''}`);
    explanation.push({ order: order++, clause: 'CREATE', title: `Create table \`${table}\` with ${columns.length} columns`, details: columns.map((c) => `\`${c.name}\` of type ${c.type}${c.flags.length ? ` (${c.flags.join(', ')})` : ''}.`) });
    if (constraints.length) explanation.push({ order: order++, clause: 'CONSTRAINTS', title: `${constraints.length} table-level constraint${constraints.length > 1 ? 's' : ''}`, details: constraints.map((c) => `\`${c}\``) });
    analysis.summary = `Defines table \`${table}\` with ${columns.length} column${columns.length !== 1 ? 's' : ''}${constraints.length ? ` and ${constraints.length} constraint${constraints.length > 1 ? 's' : ''}` : ''}.`;
    const hasPk = columns.some((c) => c.flags.includes('PK')) || constraints.some((c) => /PRIMARY KEY/i.test(c));
    if (!hasPk) add({ id: 'no-pk', severity: 'high', category: 'correctness', title: 'Table has no PRIMARY KEY', description: 'Without a primary key rows cannot be uniquely addressed; replication, ORMs and updates by id all suffer. InnoDB creates a hidden one anyway.', suggestion: 'Add `id INTEGER PRIMARY KEY` (or a natural key).' });
    const fkCols = columns.filter((c) => /_id$/i.test(c.name) && !c.flags.includes('PK'));
    const fkDeclared = columns.filter((c) => c.flags.includes('FK')).length + constraints.filter((c) => /FOREIGN KEY/i.test(c)).length;
    if (fkCols.length && !fkDeclared) add({ id: 'no-fk', severity: 'medium', category: 'correctness', title: `Columns look like foreign keys but none are declared`, description: `\`${fkCols.map((c) => c.name).join('`, `')}\` end in _id yet have no REFERENCES. Referential integrity is not enforced.`, suggestion: 'Declare `REFERENCES parent(id)` and add an index on each FK column (joins and cascading deletes need it).' });
    else if (fkCols.length) add({ id: 'fk-index', severity: 'info', category: 'performance', title: 'Index foreign key columns', description: 'Most databases (except MySQL/InnoDB) do NOT automatically index FK columns. Add indexes on ' + fkCols.map((c) => `\`${c.name}\``).join(', ') + ' for join performance.' });
    if (columns.some((c) => /^(FLOAT|DOUBLE|REAL)/.test(c.type) && /(price|amount|total|cost|balance|salary)/i.test(c.name))) add({ id: 'float-money', severity: 'high', category: 'correctness', title: 'Floating-point type for monetary column', description: 'FLOAT/DOUBLE cannot represent 0.10 exactly; rounding errors accumulate.', suggestion: 'Use DECIMAL(12,2) / NUMERIC, or store integer cents.' });
    if (columns.some((c) => /^VARCHAR\(255\)/.test(c.type)) && columns.filter((c) => /^VARCHAR\(255\)/.test(c.type)).length >= 3) add({ id: 'varchar255', severity: 'low', category: 'readability', title: 'VARCHAR(255) used as a default everywhere', description: 'Pick lengths that reflect the data (e.g. email 320, country code 2). It documents intent and helps some engines size memory buffers.' });
    if (columns.some((c) => c.type === 'ANY' || c.type === '')) add({ id: 'untyped-column', severity: 'medium', category: 'correctness', title: 'Column without a data type', description: 'Some columns have no declared type. SQLite allows this but other databases will reject it, and type affinity becomes unpredictable.' });
    if (!columns.some((c) => /created|updated/i.test(c.name))) add({ id: 'no-timestamps', severity: 'info', category: 'readability', title: 'No created_at / updated_at columns', description: 'Audit timestamps are cheap and invaluable for debugging and incremental syncs.' });
    if (columns.filter((c) => !c.flags.includes('NOT NULL') && !c.flags.includes('PK')).length === columns.length - (hasPk ? 1 : 0) && columns.length > 1) add({ id: 'all-nullable', severity: 'low', category: 'correctness', title: 'Every column is nullable', description: 'NULLs complicate every comparison and aggregate. Mark required columns NOT NULL.' });
  }
  // ===================== CREATE INDEX =====================
  else if (stype === 'CREATE' && primary.some((t) => isKw(t, 'INDEX'))) {
    analysis.statementType = 'CREATE INDEX';
    const onIdx = primary.findIndex((t) => isKw(t, 'ON'));
    const table = unquoteIdent(primary[onIdx + 1]?.value ?? '?');
    const cols = joinTokens(primary.slice(onIdx + 2));
    const unique = primary.some((t) => isKw(t, 'UNIQUE'));
    analysis.tables = [{ name: table, joinType: 'INDEX', isSubquery: false }];
    explanation.push({ order: order++, clause: 'CREATE INDEX', title: `Build ${unique ? 'a unique' : 'an'} index on \`${table}\` ${cols}`, details: ['A B-tree over these columns is built and maintained on every write; lookups, range scans and sorts on these columns become O(log n).', 'Column order matters: the index supports filters on a prefix of the listed columns.'] });
    analysis.summary = `Creates ${unique ? 'a UNIQUE ' : 'an '}index on \`${table}\` ${cols}.`;
    if (!/CONCURRENTLY|ONLINE/i.test(sql)) add({ id: 'index-locking', severity: 'info', category: 'safety', title: 'Index build may lock the table', description: 'On PostgreSQL use `CREATE INDEX CONCURRENTLY`; on MySQL 5.6+ InnoDB builds online by default; SQL Server Enterprise supports `WITH (ONLINE = ON)`.' });
    add({ id: 'index-writes', severity: 'info', category: 'performance', title: 'Every index slows writes', description: 'INSERT/UPDATE/DELETE must maintain it. Drop indexes that are not used (check pg_stat_user_indexes / sys.dm_db_index_usage_stats).' });
  }
  else if (stype === 'DROP' || stype === 'TRUNCATE') {
    analysis.statementType = stype;
    const target = primary.slice(1).map((t) => t.value).join(' ');
    explanation.push({ order: order++, clause: stype, title: `${stype === 'DROP' ? 'Remove object' : 'Empty table'} ${target}`, details: [stype === 'DROP' ? 'The object and all of its data/indexes/constraints are removed. This is usually not reversible outside of a transaction.' : 'All rows are removed by deallocating pages — much faster than DELETE, but often bypasses triggers and may not be transactional.'] });
    analysis.summary = `${stype} ${target}`;
    add({ id: 'destructive', severity: 'critical', category: 'safety', title: `${stype} is destructive`, description: 'Double-check the target object and environment. Take a backup or run inside a transaction where the engine supports transactional DDL (PostgreSQL does, MySQL does not).' });
    if (stype === 'DROP' && !primary.some((t) => isKw(t, 'IF'))) add({ id: 'drop-if-exists', severity: 'low', category: 'safety', title: 'Consider IF EXISTS', description: '`DROP ... IF EXISTS` makes migration scripts idempotent.' });
  }
  else if (stype === 'ALTER') {
    analysis.statementType = 'ALTER';
    const target = primary.slice(1, 3).map((t) => t.value).join(' ');
    explanation.push({ order: order++, clause: 'ALTER', title: `Modify ${target}`, details: [`Changes the definition: ${joinTokens(primary.slice(3))}.`] });
    analysis.summary = `Alters ${target}.`;
    add({ id: 'alter-lock', severity: 'medium', category: 'safety', title: 'Schema changes can lock large tables', description: 'Adding a column with a DEFAULT or changing a type may rewrite the whole table. Test on a copy, use online schema change tools (pt-online-schema-change, gh-ost) for big MySQL tables.' });
  }
  else {
    analysis.statementType = stype;
    analysis.summary = `${stype} statement.`;
    explanation.push({ order: order++, clause: stype, title: `${stype} statement`, details: ['This statement type is recognised but not deeply analysed. Try it in the Playground to see its effect.'] });
  }

  analysis.explanation = explanation;
  const sevRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, good: 5 };
  analysis.issues = issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  // complexity
  const factors: string[] = [];
  let score = 1;
  if (analysis.tables.length > 1) { score += (analysis.tables.length - 1) * 2; factors.push(`${analysis.tables.length - 1} join${analysis.tables.length > 2 ? 's' : ''}`); }
  if (analysis.subqueryCount) { score += analysis.subqueryCount * 3; factors.push(`${analysis.subqueryCount} subquer${analysis.subqueryCount > 1 ? 'ies' : 'y'}`); }
  if (analysis.ctes.length) { score += analysis.ctes.length * 2; factors.push(`${analysis.ctes.length} CTE${analysis.ctes.length > 1 ? 's' : ''}`); }
  if (analysis.aggregates.length) { score += 2; factors.push('aggregation'); }
  if (analysis.groupBy.length) { score += 1; factors.push('grouping'); }
  if (analysis.windowFunctions.length) { score += 3; factors.push('window functions'); }
  if (analysis.distinct) { score += 1; factors.push('DISTINCT'); }
  if (analysis.orderBy.length) { score += 1; factors.push('sorting'); }
  if (setOps.length) { score += setOps.length * 2; factors.push('set operations'); }
  if (analysis.conditions.length > 3) { score += 1; factors.push(`${analysis.conditions.length} predicates`); }
  if (/\bCASE\b/i.test(sql)) { score += 1; factors.push('CASE expressions'); }
  analysis.complexity = { score, label: score <= 3 ? 'Simple' : score <= 8 ? 'Moderate' : score <= 15 ? 'Complex' : 'Very complex', factors };
  return analysis;
}

// ---------- rewrite ----------
function buildRewrite(sql: string, a: QueryAnalysis, issues: Issue[]): string | undefined {
  let out = sql.replace(/;\s*$/, '');
  const notes: string[] = [];
  let changed = false;

  // = NULL -> IS NULL
  const nullRe = /(\S+)\s*(!=|<>)\s*NULL\b/gi;
  if (nullRe.test(out)) { out = out.replace(/(\S+)\s*(!=|<>)\s*NULL\b/gi, '$1 IS NOT NULL'); notes.push('Replaced `<> NULL` with `IS NOT NULL` (NULL comparisons with <> are never true).'); changed = true; }
  if (/(\S+)\s*=\s*NULL\b/i.test(out)) { out = out.replace(/(\S+)\s*=\s*NULL\b/gi, '$1 IS NULL'); notes.push('Replaced `= NULL` with `IS NULL`.'); changed = true; }

  // LIKE without wildcard -> =
  if (/\bLIKE\s+'([^%_']*)'/i.test(out)) { out = out.replace(/\bLIKE\s+'([^%_']*)'/gi, "= '$1'"); notes.push('Replaced `LIKE` without wildcards with `=`.'); changed = true; }

  // YEAR(col) = 2024 -> range
  const yearRe = /\bYEAR\s*\(\s*([\w.]+)\s*\)\s*=\s*(\d{4})\b/gi;
  if (yearRe.test(out)) { out = out.replace(/\bYEAR\s*\(\s*([\w.]+)\s*\)\s*=\s*(\d{4})\b/gi, (_m, col, y) => `${col} >= '${y}-01-01' AND ${col} < '${Number(y) + 1}-01-01'`); notes.push('Rewrote `YEAR(col) = y` as a sargable date range so an index on the column can be used.'); changed = true; }
  const dateRe = /\bDATE\s*\(\s*([\w.]+)\s*\)\s*=\s*'(\d{4}-\d{2}-\d{2})'/gi;
  if (dateRe.test(out)) { out = out.replace(/\bDATE\s*\(\s*([\w.]+)\s*\)\s*=\s*'(\d{4}-\d{2}-\d{2})'/gi, (_m, col, d) => { const next = new Date(d + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1); return `${col} >= '${d}' AND ${col} < '${next.toISOString().slice(0, 10)}'`; }); notes.push('Rewrote `DATE(col) = d` as a half-open range.'); changed = true; }

  // OR chain -> IN (same column, simple literals)
  const orRe = /((?:[\w.]+)\s*=\s*(?:'[^']*'|\d+(?:\.\d+)?|\?|:\w+|\$\d+))(\s+OR\s+\1(?:\s+OR\s+)?)+/gi;
  void orRe;
  {
    // generic approach: find sequences "col = v1 OR col = v2 [OR col = v3]"
    const seq = /([\w.]+)\s*=\s*('[^']*'|\d+(?:\.\d+)?|\?|:\w+|\$\d+)((?:\s+OR\s+\1\s*=\s*(?:'[^']*'|\d+(?:\.\d+)?|\?|:\w+|\$\d+))+)/gi;
    if (seq.test(out)) {
      out = out.replace(seq, (m, col) => {
        const vals = Array.from(m.matchAll(/=\s*('[^']*'|\d+(?:\.\d+)?|\?|:\w+|\$\d+)/g)).map((x) => x[1]);
        return `${col} IN (${vals.join(', ')})`;
      });
      // remove now-redundant parens like ( a IN (..) )
      notes.push('Collapsed a chain of `OR` equality checks on the same column into `IN (...)`.');
      changed = true;
    }
  }

  // NOT IN (SELECT c FROM t) -> NOT EXISTS
  const notInRe = /([\w.]+)\s+NOT\s+IN\s*\(\s*SELECT\s+([\w.]+)\s+FROM\s+([\w.]+)(?:\s+(?:AS\s+)?(\w+))?\s*(?:WHERE\s+([^()]+?))?\s*\)/gi;
  if (notInRe.test(out)) {
    out = out.replace(notInRe, (_m, outerCol, innerCol, tbl, alias, where) => {
      const a = alias || (tbl.includes('.') ? tbl.split('.').pop() : tbl);
      const innerRef = innerCol.includes('.') ? innerCol : `${a}.${innerCol}`;
      return `NOT EXISTS (SELECT 1 FROM ${tbl}${alias ? ' ' + alias : ''} WHERE ${innerRef} = ${outerCol}${where ? ' AND ' + where.trim() : ''})`;
    });
    notes.push('Rewrote `NOT IN (subquery)` as `NOT EXISTS` — NULL-safe and typically planned as an anti-join.');
    changed = true;
    const iss = issues.find((i) => i.id === 'not-in-subquery'); if (iss) iss.autoFixed = true;
  }

  // DISTINCT + GROUP BY -> remove DISTINCT
  if (a.distinct && a.groupBy.length) { out = out.replace(/\bSELECT\s+DISTINCT\b/i, 'SELECT'); notes.push('Removed redundant DISTINCT (GROUP BY already de-duplicates).'); changed = true; }

  // implicit comma joins -> explicit JOIN (simple case: AND-only where)
  if (a.statementType === 'SELECT' && a.tables.length > 1 && a.tables.slice(1).every((t) => t.joinType === 'COMMA') && a.conditions.length && !a.conditions.some((c) => c.connector === 'OR') && !a.ctes.length && !a.setOperations.length && a.subqueryCount === 0) {
    const refs = a.tables.map((t) => t.alias ?? t.name);
    const refOf = (col: string) => { const p = col.split('.'); return p.length === 2 ? p[0] : undefined; };
    const joinConds = a.conditions.filter((c) => c.op === '=' && c.column && c.value && refOf(c.column) && refOf(c.value) && refOf(c.column) !== refOf(c.value) && refs.includes(refOf(c.column)!) && refs.includes(refOf(c.value)!));
    const used = new Set<Condition>();
    const joinLines: string[] = [];
    let ok = true;
    const seen = [refs[0]];
    for (let i = 1; i < a.tables.length; i++) {
      const r = refs[i];
      const cond = joinConds.find((c) => !used.has(c) && ((refOf(c.column!) === r && seen.includes(refOf(c.value!)!)) || (refOf(c.value!) === r && seen.includes(refOf(c.column!)!))));
      if (!cond) { ok = false; break; }
      used.add(cond);
      const t = a.tables[i];
      joinLines.push(`JOIN ${t.name}${t.alias ? ' ' + t.alias : ''} ON ${cond.raw}`);
      seen.push(r);
    }
    if (ok && joinLines.length) {
      const rest = a.conditions.filter((c) => !used.has(c)).map((c) => c.raw);
      const t0 = a.tables[0];
      const fromClause = `FROM ${t0.name}${t0.alias ? ' ' + t0.alias : ''}\n${joinLines.join('\n')}` + (rest.length ? `\nWHERE ${rest.join('\n  AND ')}` : '');
      // replace FROM ... up to GROUP/ORDER/LIMIT/HAVING
      const fromMatch = out.match(/\bFROM\b[\s\S]*?(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bHAVING\b|\bOFFSET\b|$)/i);
      if (fromMatch) { out = out.replace(fromMatch[0], fromClause + '\n'); notes.push('Converted implicit comma joins into explicit `JOIN ... ON` clauses and moved the remaining predicates to WHERE.'); changed = true; const iss = issues.find((i) => i.id === 'implicit-join'); if (iss) iss.autoFixed = true; }
    }
  }

  // UNION -> keep, just note
  if (!changed) { a.rewriteNotes = []; return undefined; }
  a.rewriteNotes = notes;
  try { return format(out, { language: 'sql', keywordCase: 'upper', tabWidth: 2 }); } catch { return out; }
}

// ---------- index suggestions ----------
function suggestIndexes(a: QueryAnalysis): IndexSuggestion[] {
  const out: IndexSuggestion[] = [];
  const realTables = a.tables.filter((t) => !t.isSubquery && !a.ctes.includes(t.name));
  if (!realTables.length) return out;
  const isColRef = (v: string) => /^[A-Za-z_][\w]*\.[A-Za-z_]\w*$/.test(v.trim());
  const selectAliases = new Set(a.selectColumns.map((c) => { const m = c.match(/\s+AS\s+["`]?(\w+)["`]?$/i); return m ? m[1].toLowerCase() : null; }).filter(Boolean) as string[]);
  const resolve = (col: string): { table: string; column: string } | null => {
    const parts = col.replace(/["`[\]]/g, '').split('.');
    if (parts.length === 1 && selectAliases.has(parts[0].toLowerCase())) return null;
    if (parts.length === 1 && a.tables.length !== 1) return null;
    if (parts.length === 2) {
      const t = realTables.find((x) => x.alias === parts[0] || x.name === parts[0] || x.name.split('.').pop() === parts[0]);
      if (t) return { table: t.name, column: parts[1] };
      return null;
    }
    if (parts.length === 1 && realTables.length === 1 && /^[A-Za-z_]\w*$/.test(parts[0])) return { table: realTables[0].name, column: parts[0] };
    return null;
  };
  const perTable = new Map<string, { eq: string[]; range: string[]; sort: string[]; join: string[] }>();
  const bucket = (t: string) => { if (!perTable.has(t)) perTable.set(t, { eq: [], range: [], sort: [], join: [] }); return perTable.get(t)!; };
  const pushU = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };

  const hasOr = a.conditions.some((c) => c.connector === 'OR');
  for (const c of a.conditions) {
    if (!c.column || c.wrappedColumn || !c.op || hasOr || c.op === 'GROUP') continue;
    const r = resolve(c.column); if (!r) continue;
    if (c.op === '=' && c.value && isColRef(c.value) && resolve(c.value)) {
      // column = column across tables → join key, not a constant filter
      pushU(bucket(r.table).join, r.column);
      const r2 = resolve(c.value)!; pushU(bucket(r2.table).join, r2.column);
      continue;
    }
    if (/^id$/i.test(r.column)) continue; // primary key lookups are already indexed
    if (c.op === '=' || c.op === 'IN' || c.op === 'IS NULL') pushU(bucket(r.table).eq, r.column);
    else if (['>', '<', '>=', '<=', 'BETWEEN', 'LIKE'].includes(c.op) && !(c.op === 'LIKE' && /^'%/.test(c.value ?? ''))) pushU(bucket(r.table).range, r.column);
  }
  for (const t of a.tables) {
    if (!t.condition) continue;
    const m = t.condition.matchAll(/([\w.]+)\s*=\s*([\w.]+)/g);
    for (const x of m) {
      for (const side of [x[1], x[2]]) { const r = resolve(side); if (r) pushU(bucket(r.table).join, r.column); }
    }
  }
  for (const o of a.orderBy) { const r = resolve(o.expr); if (r) pushU(bucket(r.table).sort, r.column); }
  for (const g of a.groupBy) { const r = resolve(g); if (r) pushU(bucket(r.table).sort, r.column); }

  for (const [table, b] of perTable) {
    const cols = [...b.eq, ...b.range.slice(0, 1), ...b.sort.filter((c) => !b.eq.includes(c) && !b.range.slice(0, 1).includes(c))];
    const reasons: string[] = [];
    if (b.eq.length) reasons.push(`equality filter on ${b.eq.join(', ')}`);
    if (b.range.length) reasons.push(`range filter on ${b.range[0]}`);
    if (b.sort.length) reasons.push(`sort/group on ${b.sort.join(', ')}`);
    if (cols.length) out.push({ table, columns: cols, reason: reasons.join('; '), ddl: `CREATE INDEX idx_${table.split('.').pop()}_${cols.join('_')} ON ${table} (${cols.join(', ')});` });
    const joinOnly = b.join.filter((c) => !cols.includes(c));
    for (const jc of joinOnly) {
      if (/^id$/i.test(jc)) continue; // primary key already indexed
      out.push({ table, columns: [jc], reason: `join key ${jc}`, ddl: `CREATE INDEX idx_${table.split('.').pop()}_${jc} ON ${table} (${jc});` });
    }
  }
  return out;
}

export function severityLabel(s: Severity): string {
  return { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info', good: 'Good' }[s];
}
