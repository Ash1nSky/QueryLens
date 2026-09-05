import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Lock, ScanSearch, ShieldCheck, Sparkles, WifiOff, Cpu, Eye } from 'lucide-react';
import { AnalyzerView } from './components/AnalyzerView';
import { PlaygroundView } from './components/PlaygroundView';
import { PromptBuilderView } from './components/PromptBuilderView';
import { ANALYZER_SAMPLES, PLAYGROUND_SCENARIOS } from './lib/samples';
import { DEFAULT_DIALECT, isDialectId, type DialectId } from './lib/dialects';
import { cn } from './utils/cn';

type Mode = 'analyze' | 'playground' | 'prompt';

const MODES: { id: Mode; label: string; icon: React.ReactNode; blurb: string }[] = [
  { id: 'analyze', label: 'Analyze & Optimize', icon: <ScanSearch size={16} />, blurb: 'Explain, find issues, rewrite' },
  { id: 'playground', label: 'Interactive Playground', icon: <FlaskConical size={16} />, blurb: 'Run SQL, watch the DB tree' },
  { id: 'prompt', label: 'AI Prompt Builder', icon: <Sparkles size={16} />, blurb: 'Ask an AI without leaking data' },
];

const LS_KEY = 'querylens.state.v1';

export default function App() {
  const [mode, setMode] = useState<Mode>('analyze');
  const [analyzerSql, setAnalyzerSql] = useState<string>(() => {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); if (typeof s.analyzerSql === 'string') return s.analyzerSql; } catch { /* ignore */ }
    return ANALYZER_SAMPLES[0].sql;
  });
  const [playgroundScript, setPlaygroundScript] = useState<string>(() => {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); if (typeof s.playgroundScript === 'string') return s.playgroundScript; } catch { /* ignore */ }
    return PLAYGROUND_SCENARIOS[0].sql;
  });
  const [dialect, setDialect] = useState<DialectId>(() => {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); if (isDialectId(s.dialect)) return s.dialect; } catch { /* ignore */ }
    return DEFAULT_DIALECT;
  });
  const [promptSql, setPromptSql] = useState<string>(analyzerSql);
  const [schemaDdl, setSchemaDdl] = useState('');
  const [showHero, setShowHero] = useState(() => { try { return localStorage.getItem('querylens.hero') !== 'hidden'; } catch { return true; } });

  useEffect(() => {
    const id = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify({ analyzerSql, playgroundScript, dialect })); } catch { /* ignore */ } }, 400);
    return () => clearTimeout(id);
  }, [analyzerSql, playgroundScript, dialect]);

  const goAnalyze = useCallback((sql: string) => { setAnalyzerSql(sql); setMode('analyze'); window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  const goPlayground = useCallback((sql: string) => { setPlaygroundScript((prev) => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n-- From analyzer\n' + sql : sql)); setMode('playground'); window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  const goPrompt = useCallback(() => { setPromptSql(analyzerSql); setMode('prompt'); window.scrollTo({ top: 0, behavior: 'smooth' }); }, [analyzerSql]);
  const handleSchema = useCallback((ddl: string) => setSchemaDdl(ddl), []);

  return (
    <div className="min-h-full">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/6 bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-4 py-2.5">
          <button className="flex items-center gap-2.5" onClick={() => setShowHero(true)}>
            <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-mint-500 to-cyan-500 text-ink-950 shadow-lg shadow-mint-500/20"><ScanSearch size={18} strokeWidth={2.5} /></span>
            <span className="text-base font-bold tracking-tight text-slate-50">Query<span className="text-mint-400">Lens</span></span>
          </button>
          <nav className="ml-2 hidden items-center gap-1 rounded-xl border border-white/6 bg-white/[0.03] p-1 md:flex">
            {MODES.map((m) => (
              <button key={m.id} onClick={() => setMode(m.id)} className={cn('flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition', mode === m.id ? 'bg-white/10 text-slate-50 shadow-sm' : 'text-slate-400 hover:text-slate-100')}>
                {m.icon}{m.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-mint-500/30 bg-mint-500/10 px-2.5 py-1 text-[11px] font-medium text-mint-400 sm:flex"><Lock size={12} />100% local · no uploads</span>
            <span className="hidden items-center gap-1.5 text-[11px] text-slate-500 lg:flex"><WifiOff size={12} />works offline</span>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
          {MODES.map((m) => (
            <button key={m.id} onClick={() => setMode(m.id)} className={cn('flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium', mode === m.id ? 'border-mint-500/40 bg-mint-500/10 text-mint-400' : 'border-white/8 text-slate-400')}>{m.icon}{m.label}</button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 pb-16 pt-5">
        {showHero && (
          <section className="fade-up relative mb-6 overflow-hidden rounded-3xl border border-white/8 bg-gradient-to-br from-ink-900 via-ink-900 to-ink-800 p-6 sm:p-8">
            <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-mint-500/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl" />
            <button className="absolute right-4 top-4 text-xs text-slate-500 hover:text-slate-300" onClick={() => { setShowHero(false); localStorage.setItem('querylens.hero', 'hidden'); }}>Hide intro ✕</button>
            <div className="relative grid gap-8 lg:grid-cols-[1.3fr_1fr]">
              <div>
                <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300"><ShieldCheck size={14} className="text-mint-400" />Privacy-first SQL tooling that runs in your browser tab</p>
                <h1 className="text-3xl font-extrabold leading-tight tracking-tight text-slate-50 sm:text-4xl">Understand, optimize and <span className="bg-gradient-to-r from-mint-400 to-cyan-300 bg-clip-text text-transparent">learn SQL</span> — without pasting queries into the internet.</h1>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">QueryLens parses your statements locally, explains them in plain English in logical execution order, flags performance and correctness problems, proposes safe rewrites and indexes, and lets you run SQL against a real in-memory database while a live schema tree shows exactly what each statement changed. When you do want a second opinion from an AI, it builds an anonymised prompt for you.</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {MODES.map((m) => (
                    <button key={m.id} onClick={() => setMode(m.id)} className={cn('flex items-center gap-3 rounded-xl border px-4 py-2.5 text-left transition', mode === m.id ? 'border-mint-500/50 bg-mint-500/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]')}>
                      <span className="text-mint-400">{m.icon}</span>
                      <span><span className="block text-sm font-semibold text-slate-100">{m.label}</span><span className="block text-[11px] text-slate-500">{m.blurb}</span></span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid content-start gap-2 text-sm">
                {[
                  { icon: <WifiOff size={16} />, t: 'Zero network calls with your data', d: 'Parsing, analysis and query execution happen in JavaScript + WebAssembly on this machine. Disconnect and it still works.' },
                  { icon: <Cpu size={16} />, t: 'Real database, real plans', d: 'The playground embeds SQLite; you get actual query plans and constraint errors, not a simulation.' },
                  { icon: <Eye size={16} />, t: 'Anonymised AI prompts', d: 'Table names, columns and literals become placeholders; the mapping never leaves the page and decodes the answer.' },
                ].map((f) => (
                  <div key={f.t} className="flex gap-3 rounded-xl border border-white/6 bg-white/[0.02] p-3">
                    <span className="mt-0.5 shrink-0 text-mint-400">{f.icon}</span>
                    <div><p className="font-medium text-slate-100">{f.t}</p><p className="text-xs leading-relaxed text-slate-500">{f.d}</p></div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <div key={mode} className="fade-up">
          {mode === 'analyze' && <AnalyzerView sql={analyzerSql} setSql={setAnalyzerSql} dialect={dialect} setDialect={setDialect} onAskAi={goPrompt} onTryInPlayground={goPlayground} />}
          {mode === 'playground' && <PlaygroundView script={playgroundScript} setScript={setPlaygroundScript} onAnalyze={goAnalyze} onSchemaChange={handleSchema} />}
          {mode === 'prompt' && <PromptBuilderView sql={promptSql} setSql={setPromptSql} schemaDdl={schemaDdl} analyzerDialect={dialect} />}
        </div>
      </main>

      <footer className="border-t border-white/6 py-6 text-center text-xs text-slate-600">
        <p>QueryLens · Static analysis is heuristic — always confirm with <code className="inline">EXPLAIN</code> on production-like data. Playground uses SQLite semantics.</p>
      </footer>
    </div>
  );
}
