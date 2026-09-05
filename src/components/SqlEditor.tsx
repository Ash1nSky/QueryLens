import { useMemo, useRef, type KeyboardEvent, type UIEvent } from 'react';
import { tokenize } from '@/lib/tokenizer';
import { cn } from '@/utils/cn';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun?: () => void;
  placeholder?: string;
  className?: string;
  minHeight?: number;
  readOnly?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function highlightSql(sql: string) {
  const tokens = tokenize(sql);
  const out: { text: string; cls?: string }[] = [];
  let last = 0;
  for (const t of tokens) {
    if (t.start > last) out.push({ text: sql.slice(last, t.start) });
    out.push({ text: t.value, cls: `tok-${t.type}` });
    last = t.end;
  }
  if (last < sql.length) out.push({ text: sql.slice(last) });
  return out;
}

export function SqlCode({ sql, className }: { sql: string; className?: string }) {
  const parts = useMemo(() => highlightSql(sql), [sql]);
  return (
    <pre className={cn('overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-6', className)}>
      {parts.map((p, i) => (p.cls ? <span key={i} className={p.cls}>{p.text}</span> : <span key={i}>{p.text}</span>))}
    </pre>
  );
}

export function SqlEditor({ value, onChange, onRun, placeholder, className, minHeight = 220, readOnly, textareaRef }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const taRef = textareaRef ?? innerRef;
  const parts = useMemo(() => highlightSql(value), [value]);
  const lines = value.split('\n').length;

  const sync = (e: UIEvent<HTMLTextAreaElement>) => {
    if (preRef.current) { preRef.current.scrollTop = e.currentTarget.scrollTop; preRef.current.scrollLeft = e.currentTarget.scrollLeft; }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun?.(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart, en = ta.selectionEnd;
      const next = value.slice(0, s) + '  ' + value.slice(en);
      onChange(next);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  };

  return (
    <div className={cn('relative w-full overflow-hidden rounded-xl border border-white/10 bg-ink-950/80 font-mono text-[13px] leading-6 focus-within:border-mint-500/40 focus-within:ring-2 focus-within:ring-mint-500/15', className)} style={{ minHeight }}>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-10 select-none border-r border-white/5 bg-white/[0.02] px-2 pt-3 text-right text-[11px] text-slate-600">
        {Array.from({ length: lines }, (_, i) => <div key={i} className="h-6">{i + 1}</div>)}
      </div>
      <pre ref={preRef} aria-hidden className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words py-3 pl-13 pr-4 text-slate-200" style={{ minHeight }}>
        {parts.map((p, i) => (p.cls ? <span key={i} className={p.cls}>{p.text}</span> : <span key={i}>{p.text}</span>))}
        {'\n'}
      </pre>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        readOnly={readOnly}
        placeholder={placeholder}
        className="relative block h-full w-full resize-y whitespace-pre-wrap break-words bg-transparent py-3 pl-13 pr-4 text-transparent caret-mint-400 outline-none placeholder:text-slate-600 selection:bg-mint-500/25"
        style={{ minHeight, WebkitTextFillColor: 'transparent' }}
      />
    </div>
  );
}
