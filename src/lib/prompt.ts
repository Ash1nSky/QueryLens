import type { QueryAnalysis } from './analyzer';

export type PromptGoal = 'explain' | 'optimize' | 'debug' | 'index' | 'convert' | 'security' | 'refactor' | 'custom';

export const GOALS: { id: PromptGoal; label: string; description: string; emoji: string }[] = [
  { id: 'explain', label: 'Explain', description: 'Understand what the query does, step by step', emoji: '💡' },
  { id: 'optimize', label: 'Optimize', description: 'Make it faster and cheaper to run', emoji: '⚡' },
  { id: 'debug', label: 'Debug an error', description: 'Fix a syntax or runtime error', emoji: '🐞' },
  { id: 'index', label: 'Index advice', description: 'Which indexes would help this workload', emoji: '📇' },
  { id: 'convert', label: 'Convert dialect', description: 'Port to another database engine', emoji: '🔁' },
  { id: 'security', label: 'Security review', description: 'Check for injection and data-exposure risks', emoji: '🛡️' },
  { id: 'refactor', label: 'Refactor', description: 'Improve readability and maintainability', emoji: '🧹' },
  { id: 'custom', label: 'Custom question', description: 'Ask anything about the query', emoji: '✍️' },
];

export const DIALECTS = ['PostgreSQL', 'MySQL', 'MariaDB', 'SQLite', 'SQL Server (T-SQL)', 'Oracle', 'BigQuery', 'Snowflake', 'Redshift', 'DuckDB', 'Generic / unknown'];

export interface PromptOptions {
  goal: PromptGoal;
  dialect: string;
  targetDialect?: string;
  sql: string; // possibly anonymized
  schema?: string; // possibly anonymized DDL
  analysis?: QueryAnalysis | null;
  includeFindings: boolean;
  errorMessage?: string;
  rowCounts?: string;
  context?: string;
  customQuestion?: string;
  anonymized: boolean;
  outputFormat: 'concise' | 'detailed';
}

export function buildPrompt(o: PromptOptions): string {
  const lines: string[] = [];
  const role = 'You are a senior database engineer and SQL performance specialist.';
  lines.push(role, '');

  const goalText: Record<PromptGoal, string> = {
    explain: 'Explain what the following SQL query does. Walk through the logical execution order (FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT), describe what each clause contributes, and summarise the business meaning of the result in one paragraph.',
    optimize: 'Review the following SQL query for performance. Identify anti-patterns, explain WHY each one is slow, and provide an optimized rewrite that returns exactly the same result. Call out any assumptions you make about data distribution or indexes.',
    debug: 'The following SQL query fails. Diagnose the root cause of the error, explain it clearly, and provide a corrected version of the query.',
    index: 'Recommend indexes for the following SQL query. For each suggestion give the CREATE INDEX statement, explain which predicate/join/sort it serves, discuss column ordering, and mention the write-amplification trade-off.',
    convert: 'Convert the following SQL query to the target dialect. Preserve semantics exactly, note any functions or syntax that have no direct equivalent, and highlight behavioural differences (NULL handling, string comparison, date arithmetic).',
    security: 'Perform a security review of the following SQL. Look for injection vectors, over-broad data access, missing parameterisation, and destructive operations without safeguards. Recommend concrete mitigations.',
    refactor: 'Refactor the following SQL for readability and maintainability without changing its results: use CTEs where helpful, consistent aliases, explicit JOINs, and clear formatting. Explain each change briefly.',
    custom: o.customQuestion?.trim() || 'Answer the question below about the following SQL query.',
  };
  lines.push('## Task', goalText[o.goal], '');
  if (o.goal === 'custom' && o.customQuestion) { /* already used as task */ }
  else if (o.customQuestion?.trim()) lines.push('Additional question: ' + o.customQuestion.trim(), '');

  lines.push('## Environment', `- Database: ${o.dialect}`);
  if (o.goal === 'convert' && o.targetDialect) lines.push(`- Target database: ${o.targetDialect}`);
  if (o.rowCounts?.trim()) lines.push(`- Approximate table sizes: ${o.rowCounts.trim()}`);
  if (o.anonymized) lines.push('- Note: identifiers have been anonymised (table_1, col_2, t1 …). Keep the placeholder names in your answer so I can map them back.');
  lines.push('');

  if (o.schema?.trim()) lines.push('## Schema', '```sql', o.schema.trim(), '```', '');

  lines.push('## Query', '```sql', o.sql.trim(), '```', '');

  if (o.goal === 'debug' && o.errorMessage?.trim()) lines.push('## Error message', '```', o.errorMessage.trim(), '```', '');

  if (o.includeFindings && o.analysis && o.analysis.issues.length) {
    const relevant = o.analysis.issues.filter((i) => i.severity !== 'good');
    if (relevant.length) {
      lines.push('## Findings from my static analysis (please confirm or refute)');
      for (const i of relevant) lines.push(`- [${i.severity.toUpperCase()}${i.dialect && i.dialect !== 'generic' ? `, ${o.analysis.dialectLabel}-specific` : ''}] ${i.title}: ${i.description}`);
      lines.push('');
    }
    if (o.analysis.indexSuggestions.length) {
      lines.push('Candidate indexes I am considering:');
      for (const s of o.analysis.indexSuggestions) lines.push(`- \`${s.ddl}\` (${s.reason})`);
      lines.push('');
    }
  }

  if (o.context?.trim()) lines.push('## Additional context', o.context.trim(), '');

  lines.push('## Response format');
  if (o.outputFormat === 'concise') lines.push('Be concise. Use short bullet points and put any SQL in fenced code blocks. Lead with the single most important point.');
  else lines.push('Structure the answer with headings: Summary, Detailed analysis, Recommended SQL (in a fenced code block), Trade-offs / caveats. Rank recommendations by expected impact.');
  lines.push('Do not invent columns or tables that are not shown. If information is missing, state the assumption explicitly.');
  return lines.join('\n');
}
