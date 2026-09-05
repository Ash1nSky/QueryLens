import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, BookOpen, CheckCircle2, Database, Eraser, FlaskConical, Play, Route, RotateCcw, ScanSearch, Table2, TerminalSquare, Variable, Trash2 } from 'lucide-react';
import type { SqlJsStatic } from 'sql.js';
import { BrowserDb, loadSqlJs, type ExecEvent, type QueryResult, type SchemaSnapshot, type SessionVariable } from '@/lib/db';
import { PLAYGROUND_SCENARIOS } from '@/lib/samples';
import { splitStatements } from '@/lib/tokenizer';
import { DbTree } from './DbTree';
import { ResultTable } from './ResultTable';
import { SqlCode, SqlEditor } from './SqlEditor';
import { EmptyState, Panel, RichText } from './ui';
import { cn } from '@/utils/cn';

interface Props {
  script: string;
  setScript: (s: string) => void;
  onAnalyze: (sql: string) => void;
  onSchemaChange: (ddl: string) => void;
}

type ResultTab = 'result' | 'log' | 'plan';

export function PlaygroundView({ script, setScript, onAnalyze, onSchemaChange }: Props) {
  const sqlRef = useRef<SqlJsStatic | null>(null);
  const dbRef = useRef<BrowserDb | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SchemaSnapshot | null>(null);
  const [variables, setVariables] = useState<SessionVariable[]>([]);
  const [events, setEvents] = useState<ExecEvent[]>([]);
  const [activeEvent, setActiveEvent] = useState<ExecEvent | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableSample, setTableSample] = useState<QueryResult | null>(null);
  const [tab, setTab] = useState<ResultTab>('result');
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadSqlJs().then((SQL) => {
      if (cancelled) return;
      sqlRef.current = SQL;
      dbRef.current = new BrowserDb(SQL);
      setSnapshot(dbRef.current.snapshot());
      setReady(true);
    }).catch((e) => setLoadError((e as Error).message));
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(() => {
    const db = dbRef.current; if (!db) return;
    const snap = db.snapshot();
    setSnapshot(snap);
    setVariables(Array.from(db.variables.values()));
    onSchemaChange(db.exportSchemaDdl());
    if (selectedTable && snap.tables.some((t) => t.name === selectedTable)) setTableSample(db.tableSample(selectedTable));
    else { setSelectedTable(null); setTableSample(null); }
  }, [onSchemaChange, selectedTable]);

  const run = useCallback((text: string) => {
    const db = dbRef.current; if (!db || !text.trim()) return;
    setRunning(true);
    const before = db.snapshot();
    const { events: evs, snapshot: after } = db.execScript(text);
    const ch = new Set<string>();
    for (const t of after.tables) { const b = before.tables.find((x) => x.name === t.name); if (!b || b.rowCount !== t.rowCount || b.columns.length !== t.columns.length || b.indexes.length !== t.indexes.length) ch.add(t.name); }
    setChanged(ch);
    setEvents((prev) => [...evs.slice().reverse(), ...prev].slice(0, 200));
    const lastSelect = [...evs].reverse().find((e) => e.result);
    const lastErr = [...evs].reverse().find((e) => !e.ok);
    setActiveEvent(lastSelect ?? evs[evs.length - 1] ?? null);
    setTab(lastErr && !lastSelect ? 'log' : evs.length > 1 && !lastSelect ? 'log' : 'result');
    if (lastSelect) setSelectedTable(null);
    setSnapshot(after);
    setVariables(Array.from(db.variables.values()));
    onSchemaChange(db.exportSchemaDdl());
    setRunning(false);
    setTimeout(() => setChanged(new Set()), 2500);
  }, [onSchemaChange]);

  const runScript = () => {
    const ta = taRef.current;
    if (ta && ta.selectionStart !== ta.selectionEnd) { run(script.slice(ta.selectionStart, ta.selectionEnd)); return; }
    run(script);
  };

  const resetDb = (andRun = false) => {
    const SQL = sqlRef.current; const db = dbRef.current; if (!SQL || !db) return;
    db.reset(SQL);
    setEvents([]); setActiveEvent(null); setSelectedTable(null); setTableSample(null);
    if (andRun) run(script); else refresh();
  };

  const loadScenario = (name: string) => {
    const s = PLAYGROUND_SCENARIOS.find((x) => x.name === name); if (!s) return;
    setScript(s.sql);
    const SQL = sqlRef.current; const db = dbRef.current; if (!SQL || !db) return;
    db.reset(SQL);
    setEvents([]); setActiveEvent(null); setSelectedTable(null); setTableSample(null);
    setTimeout(() => run(s.sql), 0);
  };

  const selectTable = (name: string | null) => {
    setSelectedTable(name);
    if (name && dbRef.current) { setTableSample(dbRef.current.tableSample(name)); setTab('result'); } else setTableSample(null);
  };

  const stmtCount = useMemo(() => splitStatements(script).length, [script]);
  const shownResult = selectedTable && tableSample ? tableSample : activeEvent?.result ?? null;
  const errors = events.filter((e) => !e.ok).length;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="SQL script" icon={<TerminalSquare size={16} />} actions={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input !w-auto !py-1 text-xs" value="" onChange={(e) => loadScenario(e.target.value)}>
              <option value="" disabled>Load a scenario…</option>
              {PLAYGROUND_SCENARIOS.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
            <button className="btn btn-ghost text-xs" title="Clear editor" onClick={() => setScript('')}><Eraser size={14} /></button>
          </div>
        }>
          <div className="p-3">
            <SqlEditor value={script} onChange={setScript} onRun={runScript} textareaRef={taRef} minHeight={280} placeholder={'-- Write SQL here. Everything runs in an in-memory SQLite database inside this tab.\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\nINSERT INTO users (name) VALUES (\'Ada\');\nSELECT * FROM users;'} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-slate-500">{stmtCount} statement{stmtCount !== 1 ? 's' : ''} · select text to run only that part · <kbd className="rounded border border-white/10 bg-white/5 px-1 font-mono">Ctrl/⌘ + Enter</kbd> to run</p>
              <div className="flex gap-2">
                <button className="btn text-xs" onClick={() => resetDb(false)} disabled={!ready} title="Drop everything and start with an empty database"><Trash2 size={14} />Reset DB</button>
                <button className="btn text-xs" onClick={() => resetDb(true)} disabled={!ready || !script.trim()} title="Empty the database, then run the whole script"><RotateCcw size={14} />Reset & run</button>
                <button className="btn btn-primary text-xs" onClick={runScript} disabled={!ready || !script.trim() || running}><Play size={14} />Run</button>
              </div>
            </div>
          </div>
        </Panel>

        <Panel className="min-h-[360px]" bodyClassName="flex flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-white/6 px-2 pt-2">
            {([
              { id: 'result', label: selectedTable ? `Data: ${selectedTable}` : 'Result', icon: <Table2 size={14} /> },
              { id: 'log', label: 'What happened', icon: <Activity size={14} />, badge: events.length, warn: errors > 0 },
              { id: 'plan', label: 'Query plan', icon: <Route size={14} /> },
            ] as { id: ResultTab; label: string; icon: React.ReactNode; badge?: number; warn?: boolean }[]).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={cn('relative -mb-px flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm transition', tab === t.id ? 'border-mint-400 text-slate-50' : 'border-transparent text-slate-400 hover:text-slate-200')}>
                {t.icon}{t.label}{t.badge ? <span className={cn('ml-1 rounded-full px-1.5 text-[10px]', t.warn ? 'bg-rose-500/20 text-rose-300' : 'bg-white/10 text-slate-200')}>{t.badge}</span> : null}
              </button>
            ))}
            {activeEvent && tab === 'result' && !selectedTable && (
              <span className="ml-auto flex items-center gap-2 pr-2 text-[11px] text-slate-500">
                <span>{activeEvent.message}</span><span>· {activeEvent.ms.toFixed(1)} ms</span>
                <button className="btn btn-ghost !px-2 !py-0.5 text-[11px]" onClick={() => onAnalyze(activeEvent.statement)}><ScanSearch size={12} />Analyze</button>
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1">
            {loadError ? (
              <EmptyState icon={<AlertCircle size={32} />} title="Could not start the in-browser database" hint={loadError} />
            ) : !ready ? (
              <EmptyState icon={<Database size={32} className="animate-pulse" />} title="Starting SQLite (WebAssembly)…" hint="Loads once, runs completely offline afterwards." />
            ) : tab === 'result' ? (
              shownResult ? <ResultTable result={shownResult} className="max-h-[420px]" /> : <EmptyState icon={<FlaskConical size={32} />} title="Run a query to see results" hint="SELECT results and RETURNING rows show here. Click a table in the tree to browse its data." />
            ) : tab === 'log' ? (
              <EventLog events={events} active={activeEvent} onSelect={(e) => { setActiveEvent(e); setSelectedTable(null); if (e.result) setTab('result'); }} onAnalyze={onAnalyze} />
            ) : (
              <PlanView event={activeEvent} />
            )}
          </div>
        </Panel>
      </div>

      <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
        <Panel title="Live database tree" icon={<Database size={16} />} actions={<span className="flex items-center gap-1.5 text-[11px] text-slate-500"><span className={cn('h-1.5 w-1.5 rounded-full', ready ? 'bg-mint-400' : 'bg-amber-400')} />{ready ? 'in-memory · private' : 'loading'}</span>} bodyClassName="max-h-[calc(100vh-8rem)] overflow-auto">
          <DbTree snapshot={snapshot} variables={variables} selectedTable={selectedTable} onSelectTable={selectTable} changedTables={changed} />
          {snapshot && snapshot.tables.length === 0 && ready && (
            <div className="m-3 rounded-xl border border-dashed border-white/10 p-4 text-xs text-slate-400">
              <p className="flex items-center gap-2 font-medium text-slate-300"><BookOpen size={14} className="text-mint-400" />Learning mode</p>
              <p className="mt-1">The tree updates after every statement. Try loading the <button className="text-mint-400 underline-offset-2 hover:underline" onClick={() => loadScenario('E-commerce starter')}>E-commerce starter</button> scenario, or the <button className="text-mint-400 underline-offset-2 hover:underline" onClick={() => loadScenario('Learn: indexes & query plans')}>indexes lesson</button> to watch a full scan become an index lookup.</p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

const KIND_STYLE: Record<ExecEvent['kind'], { color: string; icon: React.ReactNode }> = {
  select: { color: 'text-sky-300 border-sky-500/30 bg-sky-500/10', icon: <Table2 size={13} /> },
  insert: { color: 'text-mint-400 border-mint-500/30 bg-mint-500/10', icon: <CheckCircle2 size={13} /> },
  update: { color: 'text-amber-300 border-amber-500/30 bg-amber-500/10', icon: <CheckCircle2 size={13} /> },
  delete: { color: 'text-orange-300 border-orange-500/30 bg-orange-500/10', icon: <Trash2 size={13} /> },
  create: { color: 'text-violet-300 border-violet-500/30 bg-violet-500/10', icon: <Database size={13} /> },
  drop: { color: 'text-rose-300 border-rose-500/30 bg-rose-500/10', icon: <Trash2 size={13} /> },
  alter: { color: 'text-violet-300 border-violet-500/30 bg-violet-500/10', icon: <Database size={13} /> },
  variable: { color: 'text-mint-400 border-mint-500/30 bg-mint-500/10', icon: <Variable size={13} /> },
  other: { color: 'text-slate-300 border-slate-500/30 bg-slate-500/10', icon: <Activity size={13} /> },
  error: { color: 'text-rose-300 border-rose-500/30 bg-rose-500/10', icon: <AlertCircle size={13} /> },
};

function EventLog({ events, active, onSelect, onAnalyze }: { events: ExecEvent[]; active: ExecEvent | null; onSelect: (e: ExecEvent) => void; onAnalyze: (s: string) => void }) {
  if (!events.length) return <EmptyState icon={<Activity size={32} />} title="Nothing has run yet" hint="Each statement you execute is logged here with a plain-English description of its effect on the database." />;
  return (
    <div className="max-h-[480px] divide-y divide-white/5 overflow-auto">
      {events.map((e, i) => {
        const s = KIND_STYLE[e.kind];
        return (
          <div key={i} className={cn('cursor-pointer px-3 py-2.5 transition hover:bg-white/[0.03]', active === e && 'bg-white/[0.04]')} onClick={() => onSelect(e)}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('chip font-sans uppercase tracking-wide', s.color)}>{s.icon}{e.kind}</span>
              <span className={cn('text-sm', e.ok ? 'text-slate-100' : 'text-rose-300')}>{e.message}</span>
              <span className="ml-auto text-[11px] text-slate-500">{e.ms.toFixed(1)} ms</span>
              <button className="btn btn-ghost !px-1.5 !py-0.5 text-[11px]" onClick={(ev) => { ev.stopPropagation(); onAnalyze(e.statement); }} title="Open in analyzer"><ScanSearch size={12} /></button>
            </div>
            <SqlCode sql={e.statement.length > 400 ? e.statement.slice(0, 400) + ' …' : e.statement} className="mt-1.5 max-h-24 rounded-md bg-ink-950/60 px-2 py-1 text-[11.5px] leading-5 text-slate-400" />
            {e.details.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-xs text-slate-400">
                {e.details.slice(0, 12).map((d, k) => <li key={k} className="flex gap-1.5"><span className="text-slate-600">–</span><RichText text={d} /></li>)}
                {e.details.length > 12 && <li className="text-slate-600">… {e.details.length - 12} more</li>}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlanView({ event }: { event: ExecEvent | null }) {
  if (!event) return <EmptyState icon={<Route size={32} />} title="No statement selected" hint="Run a SELECT / UPDATE / DELETE and its SQLite query plan appears here." />;
  if (!event.plan?.length) return <EmptyState icon={<Route size={32} />} title="No plan for this statement" hint="Query plans are produced for SELECT, INSERT…SELECT, UPDATE and DELETE statements." />;
  return (
    <div className="space-y-3 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">EXPLAIN QUERY PLAN</p>
        <pre className="mt-2 rounded-lg bg-ink-950/70 p-3 font-mono text-[12.5px] leading-6 text-cyan-200">{event.plan.join('\n')}</pre>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">What it means</p>
        <ul className="mt-2 space-y-1.5 text-sm text-slate-300">{event.details.filter((d) => /^(🔍|🚀|✅|↕️|🧮|⚠️|📦|🛠️|•)/.test(d)).map((d, i) => <li key={i}>{d}</li>)}</ul>
        <p className="mt-3 text-xs text-slate-500">Rule of thumb: <span className="text-slate-300">SCAN</span> = reads every row, <span className="text-slate-300">SEARCH … USING INDEX</span> = jumps straight to matches. Add an index on the filtered column and re-run to see the difference.</p>
      </div>
      <SqlCode sql={event.statement} className="rounded-lg border border-white/6 p-3 text-slate-400" />
    </div>
  );
}
