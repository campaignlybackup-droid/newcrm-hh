'use client';

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, Spinner } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

interface Row {
  user_id: string; full_name: string; on_date: string;
  planned_hours: number; daily_capacity_hours: number; task_count: number;
  on_leave: boolean; load_state: string;
}

/**
 * Workload heat map — hours planned against capacity, per person per day.
 *
 * These are effort estimates for balancing a team. They are not billable
 * hours: this system has no rate, no invoice and no timesheet-to-money path.
 * Approved leave greys the day out and blocks auto-assignment.
 */
export function TeamLoadHeatmap() {
  const q = useQuery({
    queryKey: ['dashboard', 'team_load'],
    queryFn: async () => {
      try {
        const { data, error } = await supabase().rpc('team_load', { p_days: 13 });
        if (error) return [];
        return (data ?? []) as unknown as Row[];
      } catch {
        return [];
      }
    },
  });

  if (q.isLoading) return <Card title="Team load"><Spinner /></Card>;
  const rows = q.data ?? [];
  if (!rows.length) return <Card title="Team load"><p className="text-[13px] text-muted">No one in your scope.</p></Card>;

  const people = [...new Map(rows.map((r) => [r.user_id, r.full_name])).entries()];
  const dates = [...new Set(rows.map((r) => String(r.on_date).slice(0, 10)))].sort();
  const byKey = new Map(rows.map((r) => [`${r.user_id}|${String(r.on_date).slice(0, 10)}`, r]));

  return (
    <Card title="Team load (next 2 weeks)">
      <div className="scroll-thin overflow-x-auto">
        <table className="border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface pr-2 text-left font-medium text-muted">Person</th>
              {dates.map((d) => (
                <th key={d} className="px-0.5 pb-1 font-normal text-muted">
                  {new Date(d).toLocaleDateString(undefined, { day: 'numeric' })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map(([id, name]) => (
              <tr key={id}>
                <td className="sticky left-0 max-w-[130px] truncate bg-surface pr-2 text-[12px]">{name}</td>
                {dates.map((d) => {
                  const cell = byKey.get(`${id}|${d}`);
                  const weekend = [0, 6].includes(new Date(d).getDay());
                  return (
                    <td key={d} className="p-0.5">
                      <div
                        title={cell
                          ? `${name} · ${d}\n${cell.planned_hours}h planned of ${cell.daily_capacity_hours}h · ${cell.task_count} task(s)${cell.on_leave ? '\nOn approved leave' : ''}`
                          : d}
                        className={cn('h-5 w-5 rounded-sm',
                          cell?.on_leave ? 'bg-border' :
                          weekend ? 'bg-raised/60' :
                          cell?.load_state === 'Over' ? 'bg-red' :
                          cell?.load_state === 'Balanced' ? 'bg-green' :
                          cell?.load_state === 'Under' ? 'bg-green/30' : 'bg-raised')}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <Legend className="bg-green/30" label="Under" />
        <Legend className="bg-green" label="Balanced" />
        <Legend className="bg-red" label="Over" />
        <Legend className="bg-border" label="On leave" />
        <span>Effort estimates for balancing work — not billable hours.</span>
      </div>
    </Card>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('h-3 w-3 rounded-sm', className)} />{label}
    </span>
  );
}
