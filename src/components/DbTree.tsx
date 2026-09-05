import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Database, Eye, Hash, Key, Link2, ListOrdered, Table2, Variable, Zap } from 'lucide-react';
import type { SchemaSnapshot, SessionVariable, TableInfo } from '@/lib/db';
import { cn } from '@/utils/cn';

export function typeColor(t: string): string {
  const u = t.toUpperCase();
  if (/INT|SERIAL/.test(u)) return 'text-orange-300 border-orange-500/30 bg-orange-500/10';
  if (/CHAR|TEXT|CLOB|STRING/.test(u)) return 'text-amber-200 border-amber-500/30 bg-amber-500/10';
  if (/REAL|FLOA|DOUB|DEC|NUM/.test(u)) return 'text-pink-300 border-pink-500/30 bg-pink-500/10';
  if (/BOOL/.test(u)) return 'text-mint-400 border-mint-500/30 bg-mint-500/10';
  if (/DATE|TIME/.test(u)) return 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10';
  if (/BLOB|BIN/.test(u)) return 'text-slate-300 border-slate-500/30 bg-slate-500/10';
  if (/NULL/.test(u)) return 'text-slate-400 border-slate-500/30 bg-slate-500/10';
  return 'text-violet-300 border-violet-500/30 bg-violet-500/10';
}

function Node({ label, icon, meta, children, defaultOpen = true, depth = 0, onClick, active, highlight, trailing }: { label: ReactNode; icon?: ReactNode; meta?: ReactNode; children?: ReactNode; defaultOpen?: boolean; depth?: number; onClick?: () => void; active?: boolean; highlight?: boolean; trailing?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = !!children;
  return (
    <div className={cn('relative', depth > 0 && 'ml-3 border-l border-white/8 pl-2')}>
      <div className={cn('group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition', onClick && 'cursor-pointer', active ? 'bg-mint-500/15 text-mint-300' : 'hover:bg-white/5', highlight && 'ring-1 ring-mint-400/60 bg-mint-500/10 fade-up')} onClick={onClick}>
        <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-500 hover:text-slate-200', !hasChildren && 'invisible')}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {icon && <span className="shrink-0 text-slate-400">{icon}</span>}
        <span className="min-w-0 truncate">{label}</span>
        {meta && <span className="ml-auto flex shrink-0 items-center gap-1">{meta}</span>}
        {trailing}
      </div>
      {hasChildren && open && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

export function DbTree({ snapshot, variables, selectedTable, onSelectTable, changedTables }: { snapshot: SchemaSnapshot | null; variables: SessionVariable[]; selectedTable: string | null; onSelectTable: (name: string | null) => void; changedTables: Set<string> }) {
  if (!snapshot) return <div className="p-4 text-sm text-slate-500">Database is loading…</div>;
  const tables = snapshot.tables.filter((t) => t.kind === 'table');
  const views = snapshot.tables.filter((t) => t.kind === 'view');
  const totalRows = tables.reduce((s, t) => s + t.rowCount, 0);

  return (
    <div className="p-2 font-mono text-[12.5px]">
      <Node label={<span className="font-sans font-semibold text-slate-100">main <span className="font-normal text-slate-500">(in-memory SQLite)</span></span>} icon={<Database size={14} className="text-mint-400" />} meta={<span className="font-sans text-[11px] text-slate-500">{tables.length} tables · {totalRows} rows</span>}>
        <Node depth={1} label={<span className="font-sans font-medium text-slate-300">Tables</span>} icon={<Table2 size={13} />} meta={<Count n={tables.length} />}>
          {tables.length === 0 && <p className="ml-6 py-1 font-sans text-xs text-slate-500">No tables yet — run a CREATE TABLE.</p>}
          {tables.map((t) => <TableNode key={t.name} t={t} depth={2} selected={selectedTable === t.name} onSelect={() => onSelectTable(selectedTable === t.name ? null : t.name)} highlight={changedTables.has(t.name)} />)}
        </Node>
        {views.length > 0 && (
          <Node depth={1} label={<span className="font-sans font-medium text-slate-300">Views</span>} icon={<Eye size={13} />} meta={<Count n={views.length} />}>
            {views.map((t) => <TableNode key={t.name} t={t} depth={2} selected={selectedTable === t.name} onSelect={() => onSelectTable(selectedTable === t.name ? null : t.name)} highlight={changedTables.has(t.name)} />)}
          </Node>
        )}
        <Node depth={1} label={<span className="font-sans font-medium text-slate-300">Relationships</span>} icon={<Link2 size={13} />} meta={<Count n={snapshot.relationships.length} />} defaultOpen={snapshot.relationships.length > 0}>
          {snapshot.relationships.length === 0 && <p className="ml-6 py-1 font-sans text-xs text-slate-500">No foreign keys declared.</p>}
          {snapshot.relationships.map((r, i) => (
            <div key={i} className="ml-3 flex items-center gap-1 border-l border-white/8 py-0.5 pl-3 text-[12px]">
              <span className="text-sky-300">{r.fromTable}</span><span className="text-slate-500">.{r.fromColumn}</span>
              <span className="mx-1 text-slate-600">→</span>
              <span className="text-sky-300">{r.toTable}</span><span className="text-slate-500">.{r.toColumn}</span>
            </div>
          ))}
        </Node>
        {snapshot.triggers.length > 0 && (
          <Node depth={1} label={<span className="font-sans font-medium text-slate-300">Triggers</span>} icon={<Zap size={13} />} meta={<Count n={snapshot.triggers.length} />}>
            {snapshot.triggers.map((t) => <div key={t} className="ml-3 border-l border-white/8 py-0.5 pl-3 text-[12px] text-slate-300">{t}</div>)}
          </Node>
        )}
        <Node depth={1} label={<span className="font-sans font-medium text-slate-300">Session variables</span>} icon={<Variable size={13} />} meta={<Count n={variables.length} />} defaultOpen={variables.length > 0}>
          {variables.length === 0 && <p className="ml-6 py-1 font-sans text-xs text-slate-500">Use <code className="text-mint-400">SET @name = value;</code> or <code className="text-mint-400">DECLARE @x INT = 5;</code></p>}
          {variables.map((v) => (
            <div key={v.name} className="ml-3 flex items-center gap-2 border-l border-white/8 py-0.5 pl-3 text-[12px]">
              <span className="text-mint-400">@{v.name}</span>
              <span className="text-slate-500">=</span>
              <span className="truncate text-slate-200">{v.value === null ? 'NULL' : typeof v.value === 'string' ? `'${v.value}'` : String(v.value)}</span>
              <span className={cn('chip ml-auto font-mono text-[10px]', typeColor(v.declared ?? v.type))}>{v.declared ?? v.type}</span>
            </div>
          ))}
        </Node>
      </Node>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-white/8 px-1.5 font-sans text-[10px] text-slate-400">{n}</span>;
}

function TableNode({ t, depth, selected, onSelect, highlight }: { t: TableInfo; depth: number; selected: boolean; onSelect: () => void; highlight: boolean }) {
  const userIndexes = t.indexes.filter((i) => !i.auto);
  return (
    <Node depth={depth} defaultOpen={true} onClick={onSelect} active={selected} highlight={highlight}
      icon={t.kind === 'view' ? <Eye size={13} className="text-violet-300" /> : <Table2 size={13} className="text-sky-300" />}
      label={<span className={cn('font-semibold', selected ? 'text-mint-300' : 'text-slate-100')}>{t.name}</span>}
      meta={<><span className="font-sans text-[11px] text-slate-500">{t.rowCount} row{t.rowCount !== 1 ? 's' : ''}</span><span className="font-sans text-[11px] text-slate-600">· {t.columns.length} col{t.columns.length !== 1 ? 's' : ''}</span></>}
    >
      {t.columns.map((c) => (
        <div key={c.name} className="ml-3 flex items-center gap-1.5 border-l border-white/8 py-[3px] pl-3 text-[12px]">
          {c.pk ? <Key size={11} className="shrink-0 text-amber-300" /> : c.fk ? <Link2 size={11} className="shrink-0 text-sky-300" /> : <Hash size={11} className="shrink-0 text-slate-600" />}
          <span className={cn('truncate', c.pk ? 'text-amber-200' : 'text-slate-200')}>{c.name}</span>
          <span className={cn('chip font-mono text-[10px]', typeColor(c.type))}>{c.type}</span>
          {c.notNull && !c.pk && <span className="chip border-white/10 bg-white/5 text-[9px] text-slate-400">NN</span>}
          {c.defaultValue !== null && c.defaultValue !== undefined && <span className="truncate text-[10px] text-slate-500" title={`DEFAULT ${c.defaultValue}`}>= {c.defaultValue}</span>}
          {c.fk && <span className="ml-auto truncate text-[10px] text-sky-400/80">→ {c.fk.table}.{c.fk.column}</span>}
        </div>
      ))}
      {userIndexes.length > 0 && (
        <div className="ml-3 border-l border-white/8 pl-3 pt-1">
          {userIndexes.map((i) => (
            <div key={i.name} className="flex items-center gap-1.5 py-[2px] text-[11px] text-slate-400">
              <ListOrdered size={11} className="text-violet-300" />
              <span className="truncate text-violet-200">{i.name}</span>
              <span className="text-slate-600">({i.columns.join(', ')})</span>
              {i.unique && <span className="chip border-white/10 bg-white/5 text-[9px]">UNIQUE</span>}
            </div>
          ))}
        </div>
      )}
    </Node>
  );
}
