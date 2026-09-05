import { useMemo, useState } from 'react';
import { ArrowLeftRight, EyeOff, FileText, KeyRound, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { analyzeSql } from '@/lib/analyzer';
import { anonymizeSql, deanonymize, type AnonymizeResult } from '@/lib/anonymizer';
import { buildPrompt, DIALECTS, GOALS, type PromptGoal } from '@/lib/prompt';
import { SqlCode, SqlEditor } from './SqlEditor';
import { CopyButton, Panel, Toggle } from './ui';
import { cn } from '@/utils/cn';

interface Props {
  sql: string;
  setSql: (s: string) => void;
  schemaDdl: string;
}

export function PromptBuilderView({ sql, setSql, schemaDdl }: Props) {
  const [goal, setGoal] = useState<PromptGoal>('optimize');
  const [dialect, setDialect] = useState('PostgreSQL');
  const [targetDialect, setTargetDialect] = useState('MySQL');
  const [anonIdents, setAnonIdents] = useState(true);
  const [anonStrings, setAnonStrings] = useState(true);
  const [anonNumbers, setAnonNumbers] = useState(false);
  const [includeSchema, setIncludeSchema] = useState(false);
  const [includeFindings, setIncludeFindings] = useState(true);
  const [outputFormat, setOutputFormat] = useState<'concise' | 'detailed'>('detailed');
  const [errorMessage, setErrorMessage] = useState('');
  const [rowCounts, setRowCounts] = useState('');
  const [context, setContext] = useState('');
  const [customQuestion, setCustomQuestion] = useState('');
  const [aiReply, setAiReply] = useState('');

  const analysis = useMemo(() => (sql.trim() ? analyzeSql(sql) : null), [sql]);
  const anonymizing = anonIdents || anonStrings || anonNumbers;

  const anon: AnonymizeResult = useMemo(() => {
    if (!anonymizing) return { sql, mapping: [] };
    return anonymizeSql(sql, analysis, { identifiers: anonIdents, strings: anonStrings, numbers: anonNumbers });
  }, [sql, analysis, anonIdents, anonStrings, anonNumbers, anonymizing]);

  // When the schema is included, anonymise schema + query in one pass so placeholders line up.
  const SEP = '\n-- <<QUERYLENS_SPLIT>>\n';
  const combined = useMemo(() => {
    if (!includeSchema || !schemaDdl.trim()) return null;
    if (!anonymizing) return { schema: schemaDdl, query: sql, mapping: [] as AnonymizeResult['mapping'] };
    const r = anonymizeSql(schemaDdl + SEP + sql, analysis, { identifiers: anonIdents, strings: anonStrings, numbers: anonNumbers });
    const idx = r.sql.indexOf(SEP);
    return { schema: idx >= 0 ? r.sql.slice(0, idx) : r.sql, query: idx >= 0 ? r.sql.slice(idx + SEP.length) : anon.sql, mapping: r.mapping };
  }, [includeSchema, schemaDdl, sql, analysis, anonIdents, anonStrings, anonNumbers, anonymizing, anon.sql, SEP]);

  const schemaAnon = { sql: combined?.schema ?? '' };
  const querySql = combined ? combined.query : anon.sql;
  const mapping = combined ? combined.mapping : anon.mapping;

  const prompt = useMemo(() => buildPrompt({
    goal, dialect, targetDialect, sql: querySql || '-- (no query provided)', schema: includeSchema ? schemaAnon.sql : undefined, analysis, includeFindings, errorMessage, rowCounts, context, customQuestion, anonymized: anonymizing && mapping.length > 0, outputFormat,
  }), [goal, dialect, targetDialect, querySql, includeSchema, schemaAnon.sql, analysis, includeFindings, errorMessage, rowCounts, context, customQuestion, anonymizing, mapping.length, outputFormat]);

  const decoded = useMemo(() => (aiReply.trim() ? deanonymize(aiReply, mapping) : ''), [aiReply, mapping]);

  const leaked = useMemo(() => {
    // identifiers in the original that still appear verbatim in the prompt (excluding keywords) — a quick privacy check
    if (!anonIdents) return [];
    return mapping.filter((m) => m.kind !== 'string' && m.kind !== 'number').map((m) => m.original).filter((o) => new RegExp(`(?<![\\w])${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(prompt.replace(/```sql[\s\S]*?```/g, '')));
  }, [mapping, prompt, anonIdents]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="What do you want to ask?" icon={<Sparkles size={16} />}>
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
            {GOALS.map((g) => (
              <button key={g.id} onClick={() => setGoal(g.id)} className={cn('flex flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition', goal === g.id ? 'border-mint-500/50 bg-mint-500/10' : 'border-white/8 bg-white/[0.02] hover:bg-white/[0.05]')}>
                <span className="text-lg leading-none">{g.emoji}</span>
                <span className="text-sm font-medium text-slate-100">{g.label}</span>
                <span className="text-[11px] leading-snug text-slate-500">{g.description}</span>
              </button>
            ))}
          </div>
          <div className="grid gap-3 border-t border-white/6 p-3 sm:grid-cols-2">
            <label className="text-xs text-slate-400">Database
              <select className="input mt-1" value={dialect} onChange={(e) => setDialect(e.target.value)}>{DIALECTS.map((d) => <option key={d}>{d}</option>)}</select>
            </label>
            {goal === 'convert' ? (
              <label className="text-xs text-slate-400">Target database
                <select className="input mt-1" value={targetDialect} onChange={(e) => setTargetDialect(e.target.value)}>{DIALECTS.map((d) => <option key={d}>{d}</option>)}</select>
              </label>
            ) : (
              <label className="text-xs text-slate-400">Answer style
                <select className="input mt-1" value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as 'concise' | 'detailed')}><option value="detailed">Detailed, structured</option><option value="concise">Concise bullets</option></select>
              </label>
            )}
            <label className="text-xs text-slate-400 sm:col-span-2">{goal === 'custom' ? 'Your question' : 'Extra question (optional)'}
              <input className="input mt-1" value={customQuestion} onChange={(e) => setCustomQuestion(e.target.value)} placeholder={goal === 'custom' ? 'e.g. Why does this return duplicate rows when a customer has two addresses?' : 'e.g. Would a materialized view help here?'} />
            </label>
            {goal === 'debug' && (
              <label className="text-xs text-slate-400 sm:col-span-2">Error message
                <textarea className="input mt-1 min-h-16 font-mono text-xs" value={errorMessage} onChange={(e) => setErrorMessage(e.target.value)} placeholder="ERROR: column reference &quot;id&quot; is ambiguous" />
              </label>
            )}
            <label className="text-xs text-slate-400">Approx. table sizes (optional)
              <input className="input mt-1" value={rowCounts} onChange={(e) => setRowCounts(e.target.value)} placeholder="orders ≈ 40M rows, customers ≈ 2M" />
            </label>
            <label className="text-xs text-slate-400">Additional context (optional)
              <input className="input mt-1" value={context} onChange={(e) => setContext(e.target.value)} placeholder="Runs every 5 min on a read replica…" />
            </label>
          </div>
        </Panel>

        <Panel title="Privacy controls" icon={<ShieldCheck size={16} />}>
          <div className="grid gap-2 p-3">
            <Toggle checked={anonIdents} onChange={setAnonIdents} label="Anonymise table & column names" hint="orders → table_1, customer_email → col_3. A mapping is kept locally so you can decode the answer." />
            <Toggle checked={anonStrings} onChange={setAnonStrings} label="Mask string literals" hint="'john@acme.com' → 'str_1'. Removes PII and business values." />
            <Toggle checked={anonNumbers} onChange={setAnonNumbers} label="Mask numeric literals" hint="IDs, amounts and thresholds. Off by default because magnitudes matter for optimisation advice." />
            <Toggle checked={includeFindings} onChange={setIncludeFindings} label="Include local analyzer findings" hint="Gives the AI a head start and lets it confirm or refute them." />
            <Toggle checked={includeSchema} onChange={setIncludeSchema} label={`Include schema from playground${schemaDdl.trim() ? '' : ' (empty — build one in the Playground)'}`} hint="CREATE TABLE statements, anonymised with the same mapping." />
          </div>
        </Panel>

        <Panel title="Query" icon={<FileText size={16} />}>
          <div className="p-3"><SqlEditor value={sql} onChange={setSql} minHeight={160} placeholder="Paste the query you want to ask about…" /></div>
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Generated prompt" icon={<Wand2 size={16} />} actions={<CopyButton text={prompt} label="Copy prompt" className="btn-primary" />}>
          {leaked.length > 0 && (
            <div className="mx-3 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Heads-up: {leaked.slice(0, 5).map((l) => <code key={l} className="inline">{l}</code>)} still appear outside the SQL block (probably in your free-text context). Consider rephrasing.
            </div>
          )}
          <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-[13px] leading-6 text-slate-300">{prompt}</pre>
          <div className="flex flex-wrap items-center gap-3 border-t border-white/6 px-4 py-2 text-[11px] text-slate-500">
            <span className="flex items-center gap-1"><EyeOff size={12} />{mapping.length ? `${mapping.length} identifiers/literals masked` : 'nothing masked'}</span>
            <span>·</span><span>{prompt.length.toLocaleString()} chars</span>
            <span>·</span><span>Paste into ChatGPT, Claude, Gemini, a local LLM, or a colleague's inbox.</span>
          </div>
        </Panel>

        {mapping.length > 0 && (
          <Panel title="Mapping (stays on this device)" icon={<KeyRound size={16} />} actions={<CopyButton text={mapping.map((m) => `${m.placeholder} = ${m.original}`).join('\n')} label="Copy mapping" />}>
            <div className="max-h-56 overflow-auto p-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[12px] sm:grid-cols-3">
                {mapping.map((m) => (
                  <div key={m.kind + m.placeholder} className="flex items-center gap-1.5 truncate rounded px-1.5 py-0.5 hover:bg-white/5">
                    <span className="text-mint-400">{m.placeholder}</span><span className="text-slate-600">←</span><span className="truncate text-slate-300" title={m.original}>{m.original}</span>
                    <span className="ml-auto rounded bg-white/5 px-1 font-sans text-[9px] uppercase text-slate-500">{m.kind}</span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        )}

        <Panel title="Decode the AI's answer" icon={<ArrowLeftRight size={16} />}>
          <div className="grid gap-3 p-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-slate-500">Paste the response you got back</p>
              <textarea className="input min-h-40 font-mono text-xs" value={aiReply} onChange={(e) => setAiReply(e.target.value)} placeholder="SELECT t1.col_1 FROM table_1 t1 WHERE …" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between"><p className="text-xs text-slate-500">With your real names restored</p>{decoded && <CopyButton text={decoded} />}</div>
              {decoded ? <SqlCode sql={decoded} className="min-h-40 rounded-lg border border-white/8 bg-ink-950/70 p-3 text-xs" /> : <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-white/10 text-xs text-slate-600">Decoded text appears here</div>}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
