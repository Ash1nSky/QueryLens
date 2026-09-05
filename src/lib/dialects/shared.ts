import type { Issue, Severity } from '../analyzer';
import type { RewriteResult, RewriteRule, RuleContext } from './types';

/** One piece of syntax that another engine uses but this dialect does not accept. */
export interface ForeignSyntax {
  /** Regex tested against `ctx.code` (strings/comments blanked), or a predicate. */
  when: RegExp | ((ctx: RuleContext) => boolean);
  /** What was found, e.g. "backtick-quoted identifiers". */
  what: string;
  /** What to use instead. */
  use: string;
  /** Where it comes from, for the explanation (e.g. "MySQL"). */
  from?: string;
}

/**
 * Emits a single consolidated "this will not run on <dialect>" finding listing
 * every foreign construct found, instead of one finding per construct.
 */
export function reportForeignSyntax(ctx: RuleContext, id: string, engine: string, items: ForeignSyntax[], severity: Severity = 'high'): void {
  const test = (it: ForeignSyntax, code: string) => (it.when instanceof RegExp ? it.when.test(code) : it.when({ ...ctx, code }));
  const hits = items.filter((it) => test(it, ctx.code));
  if (!hits.length) return;
  const many = hits.length > 1;
  const first = hits[0];
  const plural = isPlural(first.what);
  // if the automatic rewrite already removed every offending construct, say so
  const autoFixed = ctx.rewrittenCode !== undefined && !hits.some((it) => test(it, ctx.rewrittenCode!));
  ctx.add({
    id,
    severity,
    category: 'correctness',
    title: many ? `${hits.length} constructs that ${engine} does not support` : `${capitalize(first.what)} ${plural ? 'are' : 'is'} not supported by ${engine}`,
    description: many
      ? `This statement uses syntax from another SQL dialect and will fail on ${engine}: ${hits.map((h) => `${h.what}${h.from && h.from !== 'note' ? ` (${h.from})` : ''}`).join('; ')}.`
      : `${capitalize(first.what)}${first.from && first.from !== 'note' ? ` ${plural ? 'are' : 'is'} ${first.from} syntax and` : ''} will ${plural ? '' : ''}raise a syntax error on ${engine}.`,
    suggestion: hits.map((h) => `${capitalize(h.what)} → ${h.use}`).join(' · '),
    autoFixed: autoFixed || undefined,
  });
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function isPlural(what: string): boolean {
  const head = what.replace(/\s*\(.*\)\s*$/, '').trim();
  return / \/ /.test(head) || /(functions|identifiers|types|options|operators|hints|literals|placeholders|methods|parameters|variables|forms|clauses)$/i.test(head);
}

/** A regex fragment matching a parenthesised argument list with up to one level of nested parentheses. */
export const ARGS = String.raw`\((?:[^()]|\([^()]*\))*\)`;

/** Apply a list of regex rewrites in order, collecting notes and fixed issue ids. */
export function applyRewrites(sql: string, rules: RewriteRule[]): RewriteResult {
  let out = sql;
  const notes: string[] = [];
  const fixed: string[] = [];
  for (const r of rules) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = typeof r.to === 'string' ? out.replace(re, r.to) : out.replace(re, r.to as (...args: string[]) => string);
    notes.push(r.note);
    if (r.fixes) fixed.push(...(Array.isArray(r.fixes) ? r.fixes : [r.fixes]));
  }
  return { sql: out, notes, fixed };
}

/** Half-open range for a whole year. */
export function yearRange(col: string, y: string | number, quote: (d: string) => string = (d) => `'${d}'`): string {
  const n = Number(y);
  return `${col} >= ${quote(`${n}-01-01`)} AND ${col} < ${quote(`${n + 1}-01-01`)}`;
}

/** Half-open range for a single day. */
export function dayRange(col: string, d: string, quote: (d: string) => string = (x) => `'${x}'`): string {
  const next = new Date(d + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  return `${col} >= ${quote(d)} AND ${col} < ${quote(next.toISOString().slice(0, 10))}`;
}

/** Half-open range for a whole month ("2024-03"). */
export function monthRange(col: string, ym: string, quote: (d: string) => string = (x) => `'${x}'`): string {
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${col} >= ${quote(`${y}-${pad(m)}-01`)} AND ${col} < ${quote(`${ny}-${pad(nm)}-01`)}`;
}

/** Column-ish token: `t.col`, `col`, `"col"`. */
export const COL = String.raw`([\w."\[\]\x60]+)`;

/** Standard-SQL EXTRACT / date_part style predicates → range, shared by several dialects. */
export function extractYearRules(fixes?: string): RewriteRule[] {
  return [
    { re: new RegExp(String.raw`\bEXTRACT\s*\(\s*YEAR\s+FROM\s+${COL}\s*\)\s*=\s*'?(\d{4})'?`, 'gi'), to: (_m, col, y) => yearRange(col, y), note: 'Rewrote `EXTRACT(YEAR FROM col) = y` as a sargable half-open date range.', fixes },
    { re: new RegExp(String.raw`\bEXTRACT\s*\(\s*MONTH\s+FROM\s+${COL}\s*\)\s*=\s*'?(\d{1,2})'?\s+AND\s+EXTRACT\s*\(\s*YEAR\s+FROM\s+\1\s*\)\s*=\s*'?(\d{4})'?`, 'gi'), to: (_m, col, mo, y) => monthRange(col, `${y}-${String(mo).padStart(2, '0')}`), note: 'Rewrote month + year `EXTRACT` predicates as a sargable range.', fixes },
  ];
}

/** Marks issues as auto-fixed by id. */
export function markFixed(issues: Issue[], ids: string[]): void {
  for (const id of ids) { const i = issues.find((x) => x.id === id); if (i) i.autoFixed = true; }
}

/** Builds a `(?<![\w.])NAME\s*\(` regex for a function call. */
export function call(...names: string[]): RegExp {
  return new RegExp(String.raw`(?<![\w.])(?:${names.join('|')})\s*\(`, 'i');
}

/** Looks for a double-quoted token used where a string literal is expected (after a comparison operator / IN / LIKE). */
export function doubleQuotedStringLiteral(ctx: RuleContext): string | undefined {
  const t = ctx.tokens;
  for (let i = 1; i < t.length; i++) {
    const tok = t[i];
    if (tok.type !== 'identifier' || !tok.value.startsWith('"')) continue;
    const prev = t[i - 1];
    const prevIsCmp = prev.type === 'operator' && ['=', '<>', '!=', '>', '>=', '<', '<='].includes(prev.value);
    const prevIsKw = (prev.type === 'keyword') && ['LIKE', 'ILIKE', 'IN', 'VALUES', 'THEN', 'ELSE'].includes(prev.upper);
    const prevIsListSep = prev.value === ',' || prev.value === '(';
    const insideValuesOrIn = prevIsListSep && t.slice(0, i).some((x, k) => k >= i - 8 && x.type === 'keyword' && ['IN', 'VALUES'].includes(x.upper));
    if (prevIsCmp || prevIsKw || insideValuesOrIn) return tok.value;
  }
  return undefined;
}

/** Column names that are almost certainly text, used to spot `text_col = 123` implicit casts. */
export const TEXTY_COLUMN = /(^|[._])(email|phone|mobile|code|sku|slug|uuid|guid|zip|postcode|postal_code|token|hash|name|username|iban|isbn|reference|ref|number|no)$/i;
