import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, BookOpen, Braces, Database, FlaskConical, Gauge, Lightbulb, ListTree, Sparkles, Wand2, Wrench, Zap } from 'lucide-react';
import { analyzeSql, type QueryAnalysis, type Severity } from '@/lib/analyzer';
import { ANALYZER_SAMPLES } from '@/lib/samples';
import { SqlCode, SqlEditor } from './SqlEditor';
import { Chip, CopyButton, EmptyState, Panel, RichText, SEVERITY_STYLES, SeverityChip } from './ui';
import { cn } from '@/utils/cn';

interface Props {
  sql: string;
  setSql: (s: string) => void;
  onAskAi: (analysis: QueryAnalysis) => void;
  onTryInPlayground: (sql: string) => void;
}

type Tab = 'explain' | 'issues' | 'optimized' | 'indexes' | 'structure';

export function AnalyzerView({ sql, setSql, onAskAi, onTryInPlayground }: Props) {
  const [tab, setTab] = useState<Tab>('explain');
  const [debounced, setDebounced] = useState(sql);
  useEffect(() => { const id = setTimeout(() => setDebounced(sql), 250); return () => clearTimeout(id); }, [sql]);
  const analysis = useMemo(() => (debounced.trim() ? analyzeSql(debounced) : null), [debounced]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0, good: 0 };
    analysis?.issues.forEach((i) => c[i.severity]++);
    return c;
  }, [analysis]);
  const problemCount = counts.critical + counts.high + counts.medium + counts.low;

  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'explain', label: 'Explanation', icon: <BookOpen size={14} /> },
    { id: 'issues', label: 'Findings', icon: <AlertTriangle size={14} />, badge: problemCount },
    { id: 'optimized', label: 'Optimized', icon: <Wand2 size={14} /> },
    { id: 'indexes', label: 'Indexes', icon: <Zap size={14} />, badge: analysis?.indexSuggestions.length || undefined },
    { id: 'structure', label: 'Structure', icon: <ListTree size={14} /> },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* Left: editor */}
      <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
        <Panel title="Your SQL" icon={<Braces size={16} />} actions={
          <div className="flex items-center gap-2">
            <select className="input !w-auto !py-1 text-xs" value="" onChange={(e) => { const s = ANALYZER_SAMPLES.find((x) => x.name === e.target.value); if (s) setSql(s.sql); }}>
              <option value="" disabled>Load an example…</option>
              {ANALYZER_SAMPLES.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </div>
        }>
          <div className="p-3">
            <SqlEditor value={sql} onChange={setSql} minHeight={320} placeholder={'Paste a SELECT, INSERT, UPDATE, DELETE or CREATE statement…\nAnalysis runs locally as you type.'} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[11px] text-slate-500"><span className="h-1.5 w-1.5 rounded-full bg-mint-400 pulse-ring" />Analyzed in your browser — nothing is sent anywhere.</p>
              <div className="flex gap-2">
                <button className="btn text-xs" onClick={() => onTryInPlayground(sql)} disabled={!sql.trim()}><FlaskConical size={14} />Try in playground</button>
                <button className="btn btn-primary text-xs" onClick={() => analysis && onAskAi(analysis)} disabled={!analysis}><Sparkles size={14} />Build AI prompt</button>
              </div>
            </div>
          </div>
        </Panel>

        {analysis && !analysis.parseError && (
          <Panel title="At a glance" icon={<Gauge size={16} />}>
            <div className="grid grid-cols-2 gap-px bg-white/5 sm:grid-cols-4">
              <Stat label="Statement" value={analysis.statementType} />
              <Stat label="Tables" value={String(analysis.tables.filter((t) => !t.isSubquery).length)} sub={analysis.tables.length > 1 ? `${analysis.tables.length - 1} join${analysis.tables.length > 2 ? 's' : ''}` : undefined} />
              <Stat label="Complexity" value={analysis.complexity.label} sub={`score ${analysis.complexity.score}`} tone={analysis.complexity.score > 15 ? 'rose' : analysis.complexity.score > 8 ? 'amber' : 'mint'} />
              <Stat label="Findings" value={String(problemCount)} sub={counts.critical ? `${counts.critical} critical` : counts.high ? `${counts.high} high` : problemCount ? 'minor' : 'clean'} tone={counts.critical ? 'rose' : counts.high ? 'orange' : problemCount ? 'amber' : 'mint'} />
            </div>
            <div className="border-t border-white/5 px-4 py-3 text-sm text-slate-300">
              <RichText text={analysis.summary} />
            </div>
          </Panel>
        )}
      </div>

      {/* Right: results */}
      <div className="min-w-0">
        <Panel className="min-h-[560px]" bodyClassName="flex flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-white/6 px-2 pt-2">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={cn('relative -mb-px flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm transition', tab === t.id ? 'border-mint-400 text-slate-50' : 'border-transparent text-slate-400 hover:text-slate-200')}>
                {t.icon}{t.label}
                {t.badge ? <span className="ml-1 rounded-full bg-white/10 px-1.5 text-[10px] text-slate-200">{t.badge}</span> : null}
              </button>
            ))}
          </div>
          <div className="flex-1 p-4">
            {!analysis ? (
              <EmptyState icon={<Database size={36} />} title="Paste a query to get started" hint="You'll get a plain-English walkthrough, a list of performance & correctness findings, an optimized rewrite, and index suggestions — all computed locally." />
            ) : analysis.parseError ? (
              <EmptyState icon={<AlertTriangle size={36} />} title={analysis.parseError} />
            ) : tab === 'explain' ? <ExplainTab a={analysis} />
              : tab === 'issues' ? <IssuesTab a={analysis} />
              : tab === 'optimized' ? <OptimizedTab a={analysis} onTry={onTryInPlayground} />
              : tab === 'indexes' ? <IndexesTab a={analysis} />
              : <StructureTab a={analysis} />}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'mint' | 'amber' | 'rose' | 'orange' }) {
  const color = tone === 'rose' ? 'text-rose-300' : tone === 'orange' ? 'text-orange-300' : tone === 'amber' ? 'text-amber-300' : tone === 'mint' ? 'text-mint-400' : 'text-slate-100';
  return (
    <div className="bg-ink-900 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={cn('mt-0.5 truncate text-lg font-semibold', color)}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

const CLAUSE_COLORS: Record<string, string> = {
  WITH: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30', FROM: 'bg-sky-500/20 text-sky-300 border-sky-500/30', WHERE: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  'GROUP BY': 'bg-violet-500/20 text-violet-300 border-violet-500/30', HAVING: 'bg-violet-500/20 text-violet-300 border-violet-500/30', SELECT: 'bg-mint-500/20 text-mint-400 border-mint-500/30',
  'ORDER BY': 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30', LIMIT: 'bg-slate-500/20 text-slate-300 border-slate-500/30', WINDOW: 'bg-pink-500/20 text-pink-300 border-pink-500/30', SET: 'bg-orange-500/20 text-orange-300 border-orange-500/30', AGGREGATE: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
};

export function ExplainTab({ a }: { a: QueryAnalysis }) {
  return (
    <div className="fade-up space-y-4">
      <p className="text-xs text-slate-500">Logical execution order — the database conceptually evaluates clauses in this sequence, which is <em>not</em> the order you write them.</p>
      <ol className="relative space-y-3 border-l border-white/10 pl-6">
        {a.explanation.map((s) => {
          const color = CLAUSE_COLORS[s.clause] ?? (s.clause.includes('JOIN') ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-rose-500/20 text-rose-300 border-rose-500/30');
          return (
            <li key={s.order} className="relative">
              <span className="absolute -left-[31px] top-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-ink-800 text-[10px] font-bold text-slate-300">{s.order}</span>
              <div className="rounded-xl border border-white/6 bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('chip font-mono', color)}>{s.clause}</span>
                  <span className="text-sm font-medium text-slate-100"><RichText text={s.title} /></span>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-slate-400">
                  {s.details.map((d, i) => <li key={i} className="flex gap-2"><ArrowRight size={14} className="mt-1 shrink-0 text-slate-600" /><RichText text={d} /></li>)}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>
      {a.complexity.factors.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>Complexity drivers:</span>{a.complexity.factors.map((f) => <Chip key={f}>{f}</Chip>)}
        </div>
      )}
    </div>
  );
}

export function IssuesTab({ a }: { a: QueryAnalysis }) {
  const [filter, setFilter] = useState<string>('all');
  const cats = Array.from(new Set(a.issues.map((i) => i.category)));
  const list = a.issues.filter((i) => filter === 'all' || i.category === filter);
  if (!a.issues.length) return <EmptyState icon={<Lightbulb size={32} />} title="No findings" hint="Nothing stood out in this statement." />;
  return (
    <div className="fade-up space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {['all', ...cats].map((c) => <button key={c} onClick={() => setFilter(c)} className={cn('chip cursor-pointer capitalize', filter === c ? 'border-mint-500/40 bg-mint-500/15 text-mint-400' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200')}>{c}</button>)}
      </div>
      {list.map((i) => (
        <div key={i.id} className={cn('rounded-xl border p-3', i.severity === 'critical' ? 'border-rose-500/30 bg-rose-500/[0.06]' : i.severity === 'high' ? 'border-orange-500/25 bg-orange-500/[0.05]' : i.severity === 'good' ? 'border-mint-500/25 bg-mint-500/[0.05]' : 'border-white/6 bg-white/[0.02]')}>
          <div className="flex flex-wrap items-center gap-2">
            <SeverityChip severity={i.severity} />
            <span className="chip border-white/10 bg-white/5 capitalize text-slate-400">{i.category}</span>
            {i.autoFixed && <span className="chip border-mint-500/30 bg-mint-500/10 text-mint-400"><Wrench size={11} />auto-fixed in rewrite</span>}
          </div>
          <h4 className="mt-2 text-sm font-semibold text-slate-100">{i.title}</h4>
          <p className="mt-1 text-sm text-slate-400"><RichText text={i.description} /></p>
          {i.suggestion && <p className="mt-2 flex gap-2 rounded-lg bg-ink-950/60 p-2 text-sm text-slate-300"><Lightbulb size={14} className="mt-0.5 shrink-0 text-amber-300" /><RichText text={i.suggestion} /></p>}
        </div>
      ))}
    </div>
  );
}

export function OptimizedTab({ a, onTry }: { a: QueryAnalysis; onTry: (s: string) => void }) {
  const manual = a.issues.filter((i) => i.suggestion && !i.autoFixed && i.severity !== 'good' && i.severity !== 'info');
  return (
    <div className="fade-up space-y-4">
      {a.rewritten ? (
        <>
          <div className="rounded-xl border border-mint-500/25 bg-mint-500/[0.04]">
            <div className="flex items-center justify-between border-b border-white/6 px-3 py-2">
              <span className="flex items-center gap-2 text-sm font-semibold text-mint-400"><Wand2 size={14} />Optimized rewrite (semantics-preserving)</span>
              <div className="flex gap-2"><button className="btn text-xs" onClick={() => onTry(a.rewritten!)}><FlaskConical size={13} />Try</button><CopyButton text={a.rewritten} /></div>
            </div>
            <SqlCode sql={a.rewritten} className="p-3" />
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">What changed</h4>
            <ul className="space-y-1.5">{a.rewriteNotes.map((n, i) => <li key={i} className="flex gap-2 text-sm text-slate-300"><Wrench size={14} className="mt-0.5 shrink-0 text-mint-400" /><RichText text={n} /></li>)}</ul>
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-white/6 bg-white/[0.02] p-4 text-sm text-slate-400">
          <p className="font-medium text-slate-200">No automatic rewrite was applied.</p>
          <p className="mt-1">The analyzer only rewrites when it can guarantee the same result set. Below is the formatted query{manual.length ? ' and the manual optimizations worth considering' : ''}.</p>
        </div>
      )}
      <div className="rounded-xl border border-white/6">
        <div className="flex items-center justify-between border-b border-white/6 px-3 py-2"><span className="text-sm font-medium text-slate-300">Formatted original</span><CopyButton text={a.formatted} /></div>
        <SqlCode sql={a.formatted} className="p-3 text-slate-400" />
      </div>
      {manual.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Manual optimizations (need your judgement)</h4>
          <div className="space-y-2">
            {manual.map((i) => (
              <div key={i.id} className="flex gap-3 rounded-lg border border-white/6 bg-white/[0.02] p-3">
                <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', SEVERITY_STYLES[i.severity].dot)} />
                <div><p className="text-sm font-medium text-slate-200">{i.title}</p><p className="text-sm text-slate-400"><RichText text={i.suggestion!} /></p></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function IndexesTab({ a }: { a: QueryAnalysis }) {
  if (!a.indexSuggestions.length) return <EmptyState icon={<Zap size={32} />} title="No index suggestions" hint={a.statementType === 'SELECT' || a.statementType === 'UPDATE' || a.statementType === 'DELETE' ? 'Suggestions are derived from WHERE, JOIN, ORDER BY and GROUP BY columns. Qualify columns with table aliases (u.email) so they can be attributed to a table.' : 'Index suggestions apply to SELECT, UPDATE and DELETE statements.'} />;
  return (
    <div className="fade-up space-y-3">
      <p className="text-xs text-slate-500">Heuristic suggestions: equality columns first, then one range column, then sort/group columns. Verify with EXPLAIN on real data before creating — every index costs write throughput.</p>
      {a.indexSuggestions.map((s, i) => (
        <div key={i} className="rounded-xl border border-white/6 bg-white/[0.02] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm"><Database size={14} className="text-sky-300" /><span className="font-semibold text-slate-100">{s.table}</span><span className="text-slate-500">({s.columns.join(', ')})</span></div>
            <CopyButton text={s.ddl} />
          </div>
          <p className="mt-1 text-xs text-slate-400">Serves: {s.reason}</p>
          <SqlCode sql={s.ddl} className="mt-2 rounded-lg bg-ink-950/60 p-2" />
        </div>
      ))}
    </div>
  );
}

export function StructureTab({ a }: { a: QueryAnalysis }) {
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (v ? <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-white/5 py-2 text-sm last:border-0"><span className="text-slate-500">{k}</span><span className="min-w-0 text-slate-200">{v}</span></div> : null);
  const list = (arr: string[]) => (arr.length ? <div className="flex flex-wrap gap-1">{arr.map((x, i) => <code key={i} className="inline">{x}</code>)}</div> : null);
  return (
    <div className="fade-up">
      <Row k="Type" v={<Chip>{a.statementType}</Chip>} />
      <Row k="CTEs" v={list(a.ctes)} />
      <Row k="Tables" v={a.tables.length ? <div className="space-y-1">{a.tables.map((t, i) => <div key={i} className="flex flex-wrap items-center gap-2"><Chip className="font-mono text-[10px]">{t.joinType}</Chip><code className="inline">{t.name}{t.alias ? ` AS ${t.alias}` : ''}</code>{t.condition && <span className="text-xs text-slate-500">ON {t.condition}</span>}</div>)}</div> : null} />
      <Row k="Columns" v={list(a.selectColumns)} />
      <Row k="Conditions" v={a.conditions.length ? <div className="space-y-1">{a.conditions.map((c, i) => <div key={i} className="flex flex-wrap items-center gap-2 text-xs"><span className="w-8 text-slate-500">{c.connector ?? ''}</span><code className="inline">{c.raw}</code>{c.op && <Chip className="font-mono text-[10px]">{c.op}</Chip>}{c.hasSubquery && <Chip>subquery</Chip>}{c.wrappedColumn && <Chip className="border-orange-500/30 text-orange-300">non-sargable</Chip>}</div>)}</div> : null} />
      <Row k="Group by" v={list(a.groupBy)} />
      <Row k="Having" v={a.having ? <code className="inline">{a.having}</code> : null} />
      <Row k="Order by" v={a.orderBy.length ? list(a.orderBy.map((o) => `${o.expr} ${o.dir}`)) : null} />
      <Row k="Limit / Offset" v={a.limit || a.offset ? <span>{a.limit ?? '—'} / {a.offset ?? '—'}</span> : null} />
      <Row k="Aggregates" v={list(a.aggregates)} />
      <Row k="Window fns" v={list(a.windowFunctions)} />
      <Row k="Set ops" v={list(a.setOperations)} />
      <Row k="Parameters" v={list(a.parameters)} />
      <Row k="Subqueries" v={a.subqueryCount ? <span>{a.subqueryCount} (max nesting depth {a.maxDepth})</span> : null} />
    </div>
  );
}
