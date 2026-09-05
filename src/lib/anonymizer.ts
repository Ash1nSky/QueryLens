import { KEYWORDS, tokenize, unquoteIdent } from './tokenizer';
import type { QueryAnalysis } from './analyzer';

export interface AnonymizeOptions {
  identifiers: boolean;
  strings: boolean;
  numbers: boolean;
}

export interface AnonymizeResult {
  sql: string;
  mapping: { original: string; placeholder: string; kind: 'table' | 'alias' | 'column' | 'string' | 'number' | 'schema' }[];
}

const COMMON_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'LOWER', 'UPPER', 'TRIM', 'LENGTH', 'SUBSTR', 'SUBSTRING', 'CONCAT', 'ROUND', 'ABS', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'IFNULL', 'CAST', 'EXTRACT', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'GROUP_CONCAT', 'STRING_AGG', 'DATE_TRUNC', 'TO_CHAR', 'REPLACE', 'STRFTIME', 'TYPEOF', 'RANDOM', 'RAND', 'FLOOR', 'CEIL', 'CEILING', 'POWER', 'SQRT', 'MOD', 'EXISTS', 'JSON_EXTRACT', 'LEFT', 'RIGHT', 'INSTR', 'CHAR_LENGTH', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'DATEDIFF', 'DATEADD', 'GETDATE', 'ISNULL', 'NVL', 'DECODE', 'TOTAL', 'IIF', 'IF', 'GREATEST', 'LEAST', 'ARRAY_AGG', 'UNNEST', 'GENERATE_SERIES']);

/**
 * Replace identifiers/literals with neutral placeholders so the query structure
 * can be shared without leaking schema or data.
 */
export function anonymizeSql(sql: string, analysis: QueryAnalysis | null, opts: AnonymizeOptions, extraTables: string[] = []): AnonymizeResult {
  const tokens = tokenize(sql);
  const mapping: AnonymizeResult['mapping'] = [];
  const map = new Map<string, string>();
  let tCount = 0, cCount = 0, aCount = 0, sCount = 0, nCount = 0, schCount = 0;

  const tableNames = new Set<string>([...extraTables.map((t) => t.toLowerCase())]);
  const aliasNames = new Set<string>();
  if (analysis) {
    for (const t of analysis.tables) { if (!t.isSubquery) tableNames.add(t.name.toLowerCase()); if (t.alias) aliasNames.add(t.alias.toLowerCase()); }
    for (const c of analysis.ctes) tableNames.add(c.toLowerCase());
  }
  // Heuristic: identifiers directly after FROM / JOIN / INTO / UPDATE / TABLE are tables
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t.type === 'keyword') && ['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'EXISTS'].includes(t.upper)) {
      const n = tokens[i + 1];
      if (n && n.type === 'identifier') {
        // schema.table
        if (tokens[i + 2]?.value === '.' && tokens[i + 3]?.type === 'identifier') tableNames.add(unquoteIdent(tokens[i + 3].value).toLowerCase());
        else tableNames.add(unquoteIdent(n.value).toLowerCase());
        // alias
        const after = tokens[i + 2]?.value === '.' ? tokens[i + 4] : tokens[i + 2];
        if (after && after.type === 'identifier') aliasNames.add(unquoteIdent(after.value).toLowerCase());
        if (after && after.type === 'keyword' && after.upper === 'AS') { const al = tokens[tokens.indexOf(after) + 1]; if (al?.type === 'identifier') aliasNames.add(unquoteIdent(al.value).toLowerCase()); }
      }
    }
  }

  const get = (key: string, kind: AnonymizeResult['mapping'][number]['kind'], make: () => string) => {
    const k = kind + ':' + key;
    if (!map.has(k)) { const p = make(); map.set(k, p); mapping.push({ original: key, placeholder: p, kind }); }
    return map.get(k)!;
  };

  let out = '';
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    out += sql.slice(last, t.start);
    last = t.end;
    let rep = t.value;
    if (t.type === 'identifier' && opts.identifiers) {
      const raw = unquoteIdent(t.value);
      const low = raw.toLowerCase();
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const isSchemaPrefix = next?.value === '.' && tokens[i + 2]?.type === 'identifier' && tableNames.has(unquoteIdent(tokens[i + 2].value).toLowerCase()) && !aliasNames.has(low) && !tableNames.has(low);
      if (raw === '*') rep = raw;
      else if (isSchemaPrefix) rep = get(raw, 'schema', () => `schema_${++schCount}`);
      else if (tableNames.has(low)) rep = get(raw, 'table', () => `table_${++tCount}`);
      else if (aliasNames.has(low) && (prev?.value !== '.' )) rep = get(raw, 'alias', () => `t${++aCount}`);
      else rep = get(raw, 'column', () => `col_${++cCount}`);
    } else if (t.type === 'function' && opts.identifiers && !COMMON_FUNCS.has(t.upper) && !KEYWORDS.has(t.upper)) {
      rep = get(t.value, 'column', () => `fn_${++cCount}`);
    } else if (t.type === 'string' && opts.strings) {
      rep = get(t.value, 'string', () => `'str_${++sCount}'`);
    } else if (t.type === 'number' && opts.numbers) {
      rep = get(t.value, 'number', () => `${++nCount}${nCount}`);
    }
    out += rep;
  }
  out += sql.slice(last);
  return { sql: out, mapping };
}

/** Reverse a mapping in arbitrary text (e.g. an AI answer). */
export function deanonymize(text: string, mapping: AnonymizeResult['mapping']): string {
  let out = text;
  // longest placeholders first to avoid partial replacements (t1 vs t10)
  const sorted = [...mapping].sort((a, b) => b.placeholder.length - a.placeholder.length);
  for (const m of sorted) {
    const esc = m.placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'g'), m.original);
  }
  return out;
}
