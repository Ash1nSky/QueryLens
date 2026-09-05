export type TokenType =
  | 'keyword'
  | 'identifier'
  | 'string'
  | 'number'
  | 'operator'
  | 'punct'
  | 'comment'
  | 'param'
  | 'function';

export interface Token {
  type: TokenType;
  value: string; // raw text
  upper: string; // uppercased value (for keywords/identifiers)
  start: number;
  end: number;
  depth: number; // parenthesis depth
  line: number;
}

export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'AND', 'OR', 'NOT',
  'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'OFFSET', 'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'AS', 'DISTINCT', 'INSERT', 'INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'VIEW', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'PRIMARY',
  'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'CHECK', 'DEFAULT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH',
  'RECURSIVE', 'OVER', 'PARTITION', 'CAST', 'TRUE', 'FALSE', 'NATURAL', 'USING', 'FETCH', 'FIRST', 'NEXT',
  'ROWS', 'ONLY', 'TOP', 'RETURNING', 'IF', 'CONSTRAINT', 'TRUNCATE', 'ANY', 'SOME', 'EXPLAIN', 'ANALYZE',
  'TEMP', 'TEMPORARY', 'REPLACE', 'CONFLICT', 'DO', 'NOTHING', 'AUTOINCREMENT', 'AUTO_INCREMENT', 'DECLARE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'PRAGMA', 'TRIGGER', 'BEFORE', 'AFTER', 'EACH', 'ROW',
  'WINDOW', 'FILTER', 'WITHIN', 'LATERAL', 'NULLS', 'LAST', 'ESCAPE', 'COLLATE', 'GLOB', 'REGEXP', 'MATCH',
  'INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'VARCHAR', 'CHAR', 'TEXT', 'BOOLEAN', 'BOOL', 'DATE',
  'DATETIME', 'TIMESTAMP', 'TIME', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL', 'BLOB', 'JSON', 'UUID',
  'SERIAL', 'BIGSERIAL', 'CASCADE', 'RESTRICT', 'NO', 'ACTION', 'RENAME', 'TO', 'MODIFY', 'GRANT', 'REVOKE',
  'PROCEDURE', 'FUNCTION', 'RETURNS', 'LANGUAGE', 'CALL', 'EXEC', 'EXECUTE', 'MERGE', 'MATCHED', 'OUTPUT',
  'VARYING', 'PRECISION', 'UNSIGNED', 'ZEROFILL', 'ENGINE', 'CHARSET', 'CHARACTER', 'INTERVAL', 'DAY', 'MONTH',
  'YEAR', 'HOUR', 'MINUTE', 'SECOND', 'EXTRACT', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'NOW',
  'SHOW', 'DESCRIBE', 'USE', 'DATABASE', 'SCHEMA', 'IGNORE', 'GENERATED', 'ALWAYS', 'STORED', 'VIRTUAL',
  'VACUUM', 'EXCLUSIVE', 'IMMEDIATE', 'DEFERRED', 'SAVEPOINT', 'RELEASE', 'REINDEX', 'ATTACH', 'DETACH',
  'INDEXED', 'ABORT', 'FAIL', 'ISNULL', 'NOTNULL', 'RAISE', 'CURRENT', 'FOLLOWING', 'PRECEDING', 'UNBOUNDED',
  'RANGE', 'GROUPS', 'EXCLUDE', 'OTHERS', 'TIES', 'MATERIALIZED', 'WITHOUT', 'ROWID', 'STRICT', 'OF',
]);

export const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'ARRAY_AGG', 'TOTAL', 'JSON_AGG', 'LISTAGG', 'STDDEV', 'VARIANCE', 'BIT_AND', 'BIT_OR', 'BOOL_AND', 'BOOL_OR', 'EVERY']);
export const WINDOW_FUNCS = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE', 'PERCENT_RANK', 'CUME_DIST']);

const OPERATORS = ['<=>', '!=', '<>', '<=', '>=', '||', '::', '->>', '->', '=', '<', '>', '+', '-', '*', '/', '%', '~', '!', '&', '|', '^', '#'];

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  let line = 1;
  const n = sql.length;

  let lastSig: Token | undefined;
  const push = (type: TokenType, start: number, end: number, extraDepth = depth) => {
    const value = sql.slice(start, end);
    const tok: Token = { type, value, upper: value.toUpperCase(), start, end, depth: extraDepth, line };
    tokens.push(tok);
    if (type !== 'comment') lastSig = tok;
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }

    // Comments
    if (ch === '-' && next === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }
    if (ch === '#' && !/[\w]/.test(sql[i - 1] ?? ' ')) {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { if (sql[i] === '\n') line++; i++; }
      i = Math.min(n, i + 2);
      push('comment', start, i);
      continue;
    }

    // Strings
    if (ch === "'" || (ch === '"') || ch === '`' || ch === '[') {
      const quote = ch === '[' ? ']' : ch;
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote && quote !== ']') { i += 2; continue; }
          break;
        }
        if (sql[i] === '\\' && quote === "'") { i += 2; continue; }
        if (sql[i] === '\n') line++;
        i++;
      }
      i = Math.min(n, i + 1);
      push(ch === "'" ? 'string' : 'identifier', start, i);
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next ?? ''))) {
      const start = i;
      while (i < n && /[0-9a-zA-Z._]/.test(sql[i])) i++;
      push('number', start, i);
      continue;
    }

    // Params
    if (ch === '?' || ((ch === ':' && next !== ':') && /[a-zA-Z_]/.test(next ?? '')) || (ch === '@' ) || (ch === '$' && /[0-9a-zA-Z_]/.test(next ?? ''))) {
      const start = i;
      i++;
      while (i < n && /[\w]/.test(sql[i])) i++;
      push('param', start, i);
      continue;
    }

    // Identifiers / keywords
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < n && /[\w$]/.test(sql[i])) i++;
      const value = sql.slice(start, i);
      const upper = value.toUpperCase();
      // look ahead for '(' to detect function
      let j = i;
      while (j < n && /\s/.test(sql[j])) j++;
      const isCall = sql[j] === '(';
      const afterObjectKeyword = !!lastSig && lastSig.type === 'keyword' && ['INTO', 'TABLE', 'UPDATE', 'JOIN', 'FROM', 'EXISTS', 'REFERENCES', 'INDEX', 'VIEW', 'ON', 'TRIGGER', 'AS', 'OF'].includes(lastSig.upper);
      let type: TokenType;
      if (isCall && !afterObjectKeyword && !['IN', 'AND', 'OR', 'NOT', 'EXISTS', 'ON', 'WHERE', 'FROM', 'SELECT', 'VALUES', 'AS', 'THEN', 'ELSE', 'WHEN', 'BETWEEN', 'SET', 'JOIN', 'UNION', 'ALL', 'ANY', 'SOME', 'USING', 'OVER', 'BY', 'DISTINCT', 'KEY', 'REFERENCES', 'CHECK', 'UNIQUE', 'RETURNING', 'INTERSECT', 'EXCEPT', 'INTO', 'HAVING', 'FILTER', 'WITHIN', 'DEFAULT', 'LIKE', 'IS'].includes(upper)) {
        type = 'function';
      } else if (KEYWORDS.has(upper)) {
        type = 'keyword';
      } else {
        type = 'identifier';
      }
      push(type, start, i);
      continue;
    }

    // Parens
    if (ch === '(') { push('punct', i, i + 1); depth++; i++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); push('punct', i, i + 1); i++; continue; }
    if (ch === ',' || ch === ';' || ch === '.') { push('punct', i, i + 1); i++; continue; }

    // Operators
    let matched = false;
    for (const op of OPERATORS) {
      if (sql.startsWith(op, i)) { push('operator', i, i + op.length); i += op.length; matched = true; break; }
    }
    if (matched) continue;

    // Unknown char
    push('punct', i, i + 1);
    i++;
  }
  reclassifySoftKeywords(tokens);
  return tokens;
}

/** Words that are keywords in some contexts but very common column names in others. */
const SOFT_KEYWORDS = new Set(['DATE', 'TIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'KEY', 'FIRST', 'LAST', 'ROW', 'ROWS', 'ACTION', 'NO', 'DO', 'OF', 'LANGUAGE', 'MATCH', 'CURRENT', 'SCHEMA', 'DATABASE', 'TEXT', 'JSON', 'UUID', 'USE', 'SHOW', 'ENGINE', 'TEMP', 'ONLY', 'NEXT', 'TOP', 'NOTHING', 'EACH', 'FILTER', 'OTHERS', 'TIES', 'GROUPS', 'RANGE', 'WINDOW', 'STRICT', 'STORED', 'VIRTUAL', 'ALWAYS', 'GENERATED', 'ABORT', 'FAIL', 'RELEASE', 'ATTACH', 'DETACH', 'INDEXED', 'REINDEX', 'VACUUM', 'SAVEPOINT', 'TIMESTAMP', 'DATETIME', 'INTERVAL', 'TYPE', 'STATUS', 'LEVEL', 'NAME', 'VALUE', 'COMMENT', 'DATA', 'POSITION', 'RESULT', 'ROLE', 'SOURCE', 'TARGET', 'VERSION', 'ZONE', 'CHARACTER', 'PRECISION', 'OUTPUT', 'RETURNS', 'CALL', 'EXEC', 'EXECUTE', 'MERGE', 'MATCHED', 'REPLACE', 'CONFLICT', 'IGNORE', 'ROWID', 'BOOL', 'BOOLEAN', 'INT', 'INTEGER', 'FLOAT', 'REAL', 'DOUBLE', 'DECIMAL', 'NUMERIC', 'BLOB', 'CHAR', 'VARCHAR', 'BIGINT', 'SMALLINT', 'TINYINT', 'SERIAL', 'BIGSERIAL']);
const CMP_OPS = new Set(['=', '<>', '!=', '>', '>=', '<', '<=', '<=>', '+', '-', '*', '/', '||']);

function reclassifySoftKeywords(tokens: Token[]) {
  const sig = tokens.filter((t) => t.type !== 'comment');
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.type !== 'keyword' || !SOFT_KEYWORDS.has(t.upper)) continue;
    const prev = sig[i - 1];
    const next = sig[i + 1];
    const pv = prev?.value ?? '';
    const pu = prev?.upper ?? '';
    const nv = next?.value ?? '';
    const nu = next?.upper ?? '';
    const isIdent =
      pv === '.' || nv === '.' ||
      (next?.type === 'operator' && CMP_OPS.has(nv)) || (prev?.type === 'operator' && CMP_OPS.has(pv)) ||
      nu === 'AS' || ['IN', 'LIKE', 'IS', 'BETWEEN', 'NOT', 'ASC', 'DESC'].includes(nu) && next?.type === 'keyword' ||
      pu === 'BY' || pu === 'SELECT' || pu === 'DISTINCT' ||
      (pv === '(' && (nv === ')' || nv === ',')) ||
      (pv === ',' && (nv === ',' || nv === ')' || nu === 'FROM')) ||
      ((pv === ',' || pv === '(') && next?.type === 'keyword' && SOFT_KEYWORDS.has(nu) && prev && !['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'NOW'].includes(t.upper)) ||
      (pu === 'SELECT' || pu === 'WHERE' || pu === 'AND' || pu === 'OR' || pu === 'ON' || pu === 'HAVING' || pu === 'SET') && (nv === ',' || nu === 'FROM' || nu === 'IS' || nu === 'IN');
    // never reclassify a type name that directly follows a column name inside CREATE TABLE (prev is identifier)
    if (isIdent && !(prev?.type === 'identifier' && ['INT', 'INTEGER', 'TEXT', 'REAL', 'BLOB', 'DATE', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'BOOL', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NUMERIC', 'CHAR', 'VARCHAR', 'BIGINT', 'SMALLINT', 'TINYINT', 'SERIAL', 'BIGSERIAL', 'JSON', 'UUID', 'TIME'].includes(t.upper))) {
      t.type = 'identifier';
    }
  }
}

/** Split SQL text into individual statements (respecting strings, comments and parentheses). */
export function splitStatements(sql: string): string[] {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let start = 0;
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === ';' && t.depth === 0) {
      const s = sql.slice(start, t.start).trim();
      if (s) out.push(s);
      start = t.end;
    }
  }
  const last = sql.slice(start).trim();
  if (last && tokenize(last).some((t) => t.type !== 'comment')) out.push(last);
  return out;
}

export function stripComments(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'comment');
}

/** Reconstruct text from a slice of tokens, using original source spacing. */
export function sliceSource(sql: string, tokens: Token[]): string {
  if (tokens.length === 0) return '';
  return sql.slice(tokens[0].start, tokens[tokens.length - 1].end).trim();
}

export function joinTokens(tokens: Token[]): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    if (prev) {
      const noSpaceBefore = (t.type === 'punct' && (t.value === ',' || t.value === ')' || t.value === '.' || t.value === ';')) || (prev.type === 'punct' && (prev.value === '(' || prev.value === '.')) || (prev.type === 'function' && t.value === '(');
      if (!noSpaceBefore) out += ' ';
    }
    out += t.value;
  }
  return out;
}

export function unquoteIdent(s: string): string {
  if (!s) return s;
  const f = s[0];
  const l = s[s.length - 1];
  if ((f === '"' && l === '"') || (f === '`' && l === '`') || (f === '[' && l === ']')) return s.slice(1, -1);
  return s;
}
