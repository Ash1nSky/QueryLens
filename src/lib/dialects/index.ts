import type { DialectId, DialectInfo, DialectPack } from './types';
import { postgres } from './postgres';
import { mysql } from './mysql';
import { mssql } from './mssql';
import { sqlite } from './sqlite';

export type { DialectId, DialectInfo, DialectPack, RuleContext } from './types';

/** The base ruleset with no engine-specific additions. */
export const generic: DialectPack = {
  info: { id: 'generic', label: 'Generic SQL', short: 'SQL', promptName: 'Generic / unknown', formatter: 'sql', description: 'Portable best-practice rules only — no engine-specific advice' },
  rules: () => { /* nothing extra */ },
  indexDdl: ({ table, name, columns }) => `CREATE INDEX ${name} ON ${table} (${columns.join(', ')});`,
  explainTip: 'EXPLAIN',
};

export const DIALECT_PACKS: Record<DialectId, DialectPack> = { generic, postgres, mysql, mssql, sqlite };

/** Ordered list for UI selectors. */
export const DIALECT_LIST: DialectInfo[] = [generic, postgres, mysql, mssql, sqlite].map((p) => p.info);

export const DEFAULT_DIALECT: DialectId = 'generic';

export function getDialect(id: DialectId | string | null | undefined): DialectPack {
  return (id && (DIALECT_PACKS as Record<string, DialectPack>)[id]) || generic;
}

export function isDialectId(x: unknown): x is DialectId {
  return typeof x === 'string' && x in DIALECT_PACKS;
}

/** Map a dialect id to the name used by the AI prompt builder, and back. */
export function dialectToPromptName(id: DialectId): string { return getDialect(id).info.promptName; }
export function promptNameToDialect(name: string): DialectId {
  const found = DIALECT_LIST.find((d) => d.promptName === name);
  if (found) return found.id;
  if (/mariadb/i.test(name)) return 'mysql';
  return 'generic';
}

/**
 * Heuristically guess the dialect from SQL text. Returns `null` when nothing distinctive is found,
 * so callers can fall back to the generic ruleset without nagging the user.
 */
export function detectDialect(sql: string): { id: DialectId; reason: string } | null {
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^']|'')*'/g, "''");
  const score: Record<Exclude<DialectId, 'generic'>, { n: number; why: string[] }> = { postgres: { n: 0, why: [] }, mysql: { n: 0, why: [] }, mssql: { n: 0, why: [] }, sqlite: { n: 0, why: [] } };
  const hit = (d: keyof typeof score, w: number, why: string) => { score[d].n += w; if (!score[d].why.includes(why)) score[d].why.push(why); };

  if (/`[^`]+`/.test(code)) hit('mysql', 3, 'backtick identifiers');
  if (/\[[A-Za-z_][\w ]*\]\.?/.test(code) && !/\bARRAY\b/i.test(code)) hit('mssql', 3, '[bracket] identifiers');
  if (/\bSELECT\s+(DISTINCT\s+)?TOP\s*\(?\s*\d+/i.test(code)) hit('mssql', 3, 'SELECT TOP');
  if (/\bWITH\s*\(\s*NOLOCK\s*\)|\bNOLOCK\b/i.test(code)) hit('mssql', 4, 'NOLOCK');
  if (/\bOFFSET\s+\S+\s+ROWS?\s+FETCH\s+(NEXT|FIRST)/i.test(code)) hit('mssql', 3, 'OFFSET … FETCH');
  if (/\b(GETDATE|SYSDATETIME|DATEADD|DATEDIFF|DATEPART|CHARINDEX|IIF|ISNULL\s*\([^()]*,|NEWID|SCOPE_IDENTITY|LEN)\s*\(/i.test(code)) hit('mssql', 2, 'T-SQL functions');
  if (/\bN'[^']*'/.test(sql)) hit('mssql', 2, "N'…' literals");
  if (/\bDECLARE\s+@\w+\s+\w+/i.test(code) || /\bSET\s+NOCOUNT\b/i.test(code)) hit('mssql', 3, 'T-SQL variables');
  if (/\bNVARCHAR\b|\bUNIQUEIDENTIFIER\b|\bDATETIME2\b|\bIDENTITY\s*\(/i.test(code)) hit('mssql', 3, 'T-SQL types');
  if (/\bCROSS\s+APPLY\b|\bOUTER\s+APPLY\b/i.test(code)) hit('mssql', 4, 'APPLY');
  if (/::\s*[A-Za-z]/.test(code)) hit('postgres', 3, ':: casts');
  if (/\bILIKE\b/i.test(code)) hit('postgres', 4, 'ILIKE');
  if (/\$\d+\b/.test(code)) hit('postgres', 2, '$1 parameters');
  if (/\bRETURNING\b/i.test(code)) { hit('postgres', 2, 'RETURNING'); hit('sqlite', 1, 'RETURNING'); }
  if (/\bON\s+CONFLICT\b/i.test(code)) { hit('postgres', 2, 'ON CONFLICT'); hit('sqlite', 2, 'ON CONFLICT'); }
  if (/\b(DATE_TRUNC|DATE_PART|GEN_RANDOM_UUID|STRING_AGG|ARRAY_AGG|TO_CHAR|TO_TIMESTAMP|UNNEST|GENERATE_SERIES|JSONB_\w+|REGEXP_MATCHES|SPLIT_PART)\s*\(/i.test(code)) hit('postgres', 2, 'PostgreSQL functions');
  if (/\b(TIMESTAMPTZ|JSONB|BIGSERIAL|SERIAL|BYTEA|TEXT\[\]|INT\[\])\b/i.test(code) || /\bWITH\s+TIME\s+ZONE\b/i.test(code)) hit('postgres', 3, 'PostgreSQL types');
  if (/\bDISTINCT\s+ON\s*\(/i.test(code) || /\bLATERAL\b/i.test(code) || /->>?\s*'/.test(sql) && !/\bJSON_/i.test(code)) hit('postgres', 3, 'DISTINCT ON / LATERAL / JSON operators');
  if (/\bCREATE\s+INDEX\s+CONCURRENTLY\b/i.test(code) || /\bUSING\s+(GIN|GIST|BRIN)\b/i.test(code)) hit('postgres', 4, 'CONCURRENTLY / GIN');
  if (/\bLIMIT\s+\d+\s*,\s*\d+/i.test(code)) hit('mysql', 3, 'LIMIT offset, count');
  if (/\bON\s+DUPLICATE\s+KEY\b|\bINSERT\s+IGNORE\b|\bREPLACE\s+INTO\b/i.test(code)) hit('mysql', 4, 'ON DUPLICATE KEY / INSERT IGNORE');
  if (/\bAUTO_INCREMENT\b|\bENGINE\s*=|\butf8mb4\b|\bUNSIGNED\b|\bTINYINT\b|\bMEDIUMTEXT\b|\bLONGTEXT\b/i.test(code)) hit('mysql', 3, 'MySQL DDL');
  if (/\b(IFNULL|GROUP_CONCAT|DATE_FORMAT|STR_TO_DATE|DATE_SUB|DATE_ADD|UNIX_TIMESTAMP|FROM_UNIXTIME|LAST_INSERT_ID|SUBSTRING_INDEX|FOUND_ROWS)\s*\(/i.test(code)) hit('mysql', 2, 'MySQL functions');
  if (/\bIFNULL\s*\(/i.test(code)) hit('sqlite', 1, 'IFNULL');
  if (/\bGROUP_CONCAT\s*\(/i.test(code)) hit('sqlite', 1, 'GROUP_CONCAT');
  if (/\bSTRAIGHT_JOIN\b|\b(USE|FORCE|IGNORE)\s+INDEX\b|\bSQL_CALC_FOUND_ROWS\b/i.test(code)) hit('mysql', 4, 'index hints');
  if (/\bREGEXP\b|\bRLIKE\b/i.test(code)) { hit('mysql', 2, 'REGEXP'); hit('sqlite', 1, 'REGEXP'); }
  if (/\bAUTOINCREMENT\b/i.test(code)) hit('sqlite', 4, 'AUTOINCREMENT');
  if (/\bPRAGMA\b|\bWITHOUT\s+ROWID\b|\browid\b|\bSTRICT\b\s*;?\s*$/i.test(code)) hit('sqlite', 4, 'PRAGMA / rowid');
  if (/\b(STRFTIME|JULIANDAY|RANDOMBLOB|TOTAL|JSON_EACH|SQLITE_VERSION|LAST_INSERT_ROWID|TYPEOF)\s*\(/i.test(code) || /\bDATETIME\s*\(\s*'now'/i.test(sql)) hit('sqlite', 3, 'SQLite functions');
  if (/\bINSERT\s+OR\s+(IGNORE|REPLACE|ABORT)\b/i.test(code) || /\bGLOB\b/i.test(code)) hit('sqlite', 4, 'INSERT OR … / GLOB');
  if (/\bINTEGER\s+PRIMARY\s+KEY\b/i.test(code) && !/\bAUTO_INCREMENT\b|\bSERIAL\b|\bIDENTITY\b/i.test(code)) hit('sqlite', 1, 'INTEGER PRIMARY KEY');

  const ranked = (Object.entries(score) as [Exclude<DialectId, 'generic'>, { n: number; why: string[] }][]).sort((a, b) => b[1].n - a[1].n);
  const [best, second] = ranked;
  if (best[1].n < 3 || best[1].n === second[1].n) return null;
  return { id: best[0], reason: best[1].why.slice(0, 3).join(', ') };
}
