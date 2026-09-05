import type { Issue, QueryAnalysis } from '../analyzer';
import type { Token } from '../tokenizer';

/** Supported rule packs. `generic` = the base ruleset only. */
export type DialectId = 'generic' | 'postgres' | 'mysql' | 'mssql' | 'sqlite';

export interface DialectInfo {
  id: DialectId;
  /** Human label, e.g. "PostgreSQL". */
  label: string;
  /** Short badge text, e.g. "PG". */
  short: string;
  /** Name used by the AI prompt builder's "Database" field. */
  promptName: string;
  /** sql-formatter language id. */
  formatter: 'sql' | 'postgresql' | 'mysql' | 'transactsql' | 'sqlite';
  description: string;
}

/** Partial issue where every field can also be derived from the current issue. */
export type IssuePatch = { [K in keyof Issue]?: Issue[K] | ((i: Issue) => Issue[K]) };

export interface DdlColumn { name: string; type: string; flags: string[] }

/** What a rule pack sees. Everything is computed once per analysis. */
export interface RuleContext {
  dialect: DialectId;
  /** Original SQL text. */
  sql: string;
  /** SQL with comments blanked and string-literal bodies blanked — safe for keyword regexes. */
  code: string;
  /** Comment-free tokens. */
  tokens: Token[];
  a: QueryAnalysis;
  issues: Issue[];
  /** Columns parsed from a CREATE TABLE statement (empty otherwise). */
  columns: DdlColumn[];
  /** Add a finding (tagged with this dialect; ignored if the id already exists). */
  add(issue: Issue): void;
  has(id: string): boolean;
  remove(id: string): void;
  /** Patch an existing (usually generic) finding — it becomes tagged with this dialect. No-op if absent. Each field may be a value or a function of the current issue. */
  amend(id: string, patch: IssuePatch): void;
  /**
   * Dialect-specific advice for a "function on column" pattern. If the generic analyzer already
   * reported `fn-on-column-<FN>` (or plain `fn-on-column` for UPDATE/DELETE) for one of `fnNames`,
   * that finding is amended; otherwise `issue` is added as-is. Either way `issue.id` becomes an
   * alias for the resulting finding so rewrites can mark it auto-fixed.
   */
  fnIssue(fnNames: string[], issue: Issue): void;
  /** Resolve an alias registered by fnIssue() to the actual issue id. */
  resolveId(id: string): string;
  /** `code` of the auto-rewritten SQL, if a rewrite was produced (strings blanked). */
  rewrittenCode?: string;
  /** True if any function-call token has one of these names. */
  fn(...names: string[]): boolean;
  /** Names of function calls present, filtered to the given list. */
  fns(names: string[]): string[];
  /** True if a keyword/identifier token with this upper-cased text exists. */
  kw(...words: string[]): boolean;
  /** Test a regex against `code`. */
  re(r: RegExp): boolean;
}

export interface RewriteRule {
  re: RegExp;
  to: string | ((...m: string[]) => string);
  note: string;
  /** Issue id(s) to flag as auto-fixed when this rule fires. */
  fixes?: string | string[];
}

export interface RewriteResult { sql: string; notes: string[]; fixed: string[] }

export interface IndexDdlInput { table: string; name: string; columns: string[]; include?: string[] }

export interface DialectPack {
  info: DialectInfo;
  /** Add / amend / remove findings. Runs after the generic ruleset. */
  rules(ctx: RuleContext): void;
  /** Safe, semantics-preserving text rewrites specific to this dialect. */
  rewrite?(sql: string, ctx: RuleContext): RewriteResult;
  /** DDL for a suggested index in this dialect's syntax. */
  indexDdl(s: IndexDdlInput): string;
  /** Sentence used in the "looks good" finding, e.g. which EXPLAIN flavour to run. */
  explainTip: string;
}
