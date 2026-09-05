import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { Severity } from '@/lib/analyzer';
import { DIALECT_LIST, getDialect, type DialectId } from '@/lib/dialects';

export function Panel({ title, icon, actions, children, className, bodyClassName }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('panel flex flex-col overflow-hidden', className)}>
      {title && (
        <header className="panel-head">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            {icon && <span className="text-mint-400">{icon}</span>}
            {title}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export const SEVERITY_STYLES: Record<Severity, { chip: string; dot: string; label: string }> = {
  critical: { chip: 'border-rose-500/40 bg-rose-500/15 text-rose-300', dot: 'bg-rose-400', label: 'Critical' },
  high: { chip: 'border-orange-500/40 bg-orange-500/15 text-orange-300', dot: 'bg-orange-400', label: 'High' },
  medium: { chip: 'border-amber-500/40 bg-amber-500/15 text-amber-300', dot: 'bg-amber-400', label: 'Medium' },
  low: { chip: 'border-sky-500/40 bg-sky-500/15 text-sky-300', dot: 'bg-sky-400', label: 'Low' },
  info: { chip: 'border-slate-500/40 bg-slate-500/15 text-slate-300', dot: 'bg-slate-400', label: 'Info' },
  good: { chip: 'border-mint-500/40 bg-mint-500/15 text-mint-400', dot: 'bg-mint-400', label: 'Good' },
};

export function SeverityChip({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLES[severity];
  return <span className={cn('chip', s.chip)}><span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />{s.label}</span>;
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('chip border-white/10 bg-white/5 text-slate-300', className)}>{children}</span>;
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cn('btn text-xs', className)}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch {
          const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        setDone(true); setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={14} className="text-mint-400" /> : <Copy size={14} />}
      {done ? 'Copied' : label}
    </button>
  );
}

/** Renders text with `code` spans highlighted. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <span className={className}>
      {parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') ? <code key={i} className="inline">{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}
    </span>
  );
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="text-slate-500">{icon}</div>
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint && <p className="max-w-sm text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/6 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.04]">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cn('mt-0.5 relative h-5 w-9 shrink-0 rounded-full border transition', checked ? 'border-mint-500/50 bg-mint-500/40' : 'border-white/10 bg-white/10')}>
        <span className={cn('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      <span className="flex flex-col">
        <span className="text-sm text-slate-200">{label}</span>
        {hint && <span className="text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export const DIALECT_STYLES: Record<DialectId, string> = {
  generic: 'border-slate-500/40 bg-slate-500/15 text-slate-300',
  postgres: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
  mysql: 'border-orange-500/40 bg-orange-500/15 text-orange-300',
  mssql: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  sqlite: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300',
};

/** Small badge naming the dialect a finding came from. */
export function DialectChip({ dialect, className, title }: { dialect: DialectId; className?: string; title?: string }) {
  const info = getDialect(dialect).info;
  return <span className={cn('chip font-mono uppercase tracking-wide', DIALECT_STYLES[dialect], className)} title={title ?? `${info.label}-specific`}>{info.short}</span>;
}

/** Dropdown to pick the analysis dialect. */
export function DialectSelect({ value, onChange, className, compact }: { value: DialectId; onChange: (d: DialectId) => void; className?: string; compact?: boolean }) {
  return (
    <label className={cn('flex items-center gap-1.5 text-xs text-slate-400', className)} title="Dialect-specific rules are layered on top of the generic SQL ruleset">
      {!compact && <span className="hidden sm:inline">Dialect</span>}
      <select className="input !w-auto !py-1 text-xs" value={value} onChange={(e) => onChange(e.target.value as DialectId)}>
        {DIALECT_LIST.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
    </label>
  );
}
