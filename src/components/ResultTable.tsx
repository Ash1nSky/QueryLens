import type { QueryResult } from '@/lib/db';
import { cn } from '@/utils/cn';

export function ResultTable({ result, max = 200, className }: { result: QueryResult; max?: number; className?: string }) {
  if (!result.columns.length) return <p className="p-4 text-sm text-slate-500">Statement produced no result set.</p>;
  const rows = result.values.slice(0, max);
  return (
    <div className={cn('overflow-auto', className)}>
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead className="sticky top-0 z-10 bg-ink-850">
          <tr>
            <th className="border-b border-r border-white/8 px-2 py-1.5 text-left text-[10px] font-medium text-slate-500">#</th>
            {result.columns.map((c, i) => <th key={i} className="whitespace-nowrap border-b border-white/8 px-3 py-1.5 text-left font-semibold text-slate-200">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="odd:bg-white/[0.015] hover:bg-mint-500/5">
              <td className="border-r border-white/8 px-2 py-1 text-[10px] text-slate-600">{ri + 1}</td>
              {r.map((v, ci) => (
                <td key={ci} className={cn('max-w-[320px] truncate whitespace-nowrap px-3 py-1', v === null ? 'italic text-slate-600' : typeof v === 'number' ? 'text-orange-200' : 'text-slate-300')} title={v === null ? 'NULL' : String(v)}>
                  {v === null ? 'NULL' : v instanceof Uint8Array ? `<blob ${v.length}B>` : String(v)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={result.columns.length + 1} className="px-3 py-6 text-center text-slate-500">0 rows</td></tr>}
        </tbody>
      </table>
      {result.values.length > max && <p className="border-t border-white/6 px-3 py-1.5 text-[11px] text-slate-500">Showing first {max} of {result.values.length} rows.</p>}
    </div>
  );
}
