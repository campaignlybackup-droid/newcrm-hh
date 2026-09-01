'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { Card, Spinner, StatusChip, Button, Empty } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import { cn } from '@/lib/utils';

export function SalesPipelineStream() {
  const queryClient = useQueryClient();
  const [convertingLeadId, setConvertingLeadId] = useState<string | null>(null);

  // Query 1: Active Leads Stream
  const leadsQuery = useQuery({
    queryKey: ['sales_dashboard', 'leads'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('leads')
        .select('*, owner:users!leads_owner_id_fkey(full_name)')
        .is('deleted_at', null)
        .order('next_action_date', { ascending: true })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Query 2: Overdue Follow-ups
  const overdueQuery = useQuery({
    queryKey: ['sales_dashboard', 'overdue_actions'],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase()
        .from('leads')
        .select('*, owner:users!leads_owner_id_fkey(full_name)')
        .is('deleted_at', null)
        .lt('next_action_date', today)
        .order('next_action_date', { ascending: true })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Mutation: Convert Lead to Client RPC
  const convertMutation = useMutation({
    mutationFn: async (leadId: string) => {
      const { data, error } = await supabase().rpc('convert_lead_to_client', { p_lead_id: leadId });
      if (error) throw error;
      return data;
    },
    onSuccess: (clientId) => {
      pushToast('Lead converted to Client profile successfully! All contacts transferred.');
      setConvertingLeadId(null);
      queryClient.invalidateQueries({ queryKey: ['sales_dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['records'] });
    },
    onError: (err) => {
      pushToast(err instanceof Error ? err.message : 'Conversion failed', 'error');
      setConvertingLeadId(null);
    },
  });

  return (
    <div className="space-y-4 col-span-full lg:col-span-2">
      {/* Sales Suite Header */}
      <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
        <h2 className="text-sm font-semibold text-accent flex items-center gap-2">
          <span>🎯</span> Sales & Lead Management Pipeline Hub
        </h2>
        <p className="mt-1 text-xs text-muted">
          Manage deal movement, schedule client proposals, track follow-up dates, and convert won leads to active clients.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Active Lead Stream Panel */}
        <Card
          title="Active Leads Pipeline"
          action={<Link href="/leads" className="text-[12px] text-accent hover:underline">All Leads</Link>}
        >
          {leadsQuery.isLoading && <Spinner />}
          {leadsQuery.data && !leadsQuery.data.length && <Empty title="No active leads" />}
          <ul className="divide-y divide-border">
            {leadsQuery.data?.map((l) => {
              const stage = String(l.stage ?? 'New');
              const isWon = stage === 'Won';
              const isConverted = Boolean(l.converted_client_id);
              return (
                <li key={String(l.id)} className="py-2.5 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/leads/${String(l.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                      {String(l.company ?? l.brand_name ?? 'Lead Company')}
                    </Link>
                    <div className="flex items-center gap-1.5">
                      <StatusChip value={stage} />
                      {isWon && !isConverted && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={convertMutation.isPending && convertingLeadId === String(l.id)}
                          onClick={() => {
                            setConvertingLeadId(String(l.id));
                            convertMutation.mutate(String(l.id));
                          }}
                        >
                          Convert to Client
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                    <span>
                      Contact: {String(l.contact_name ?? '—')}
                      {Boolean(l.owner) && ` · Owner: ${String((l.owner as { full_name?: string })?.full_name ?? '')}`}
                    </span>
                    <span className="tabular-nums font-mono">
                      Next action: {String(l.next_action_date ?? 'Unscheduled')}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Overdue Follow-up Actions Panel */}
        <Card
          title="Follow-ups Requiring Immediate Action"
          action={<Link href="/leads" className="text-[12px] text-accent hover:underline">View Pipeline</Link>}
        >
          {overdueQuery.isLoading && <Spinner />}
          {overdueQuery.data && !overdueQuery.data.length && (
            <p className="text-[13px] text-muted py-2">No overdue follow-up actions. All up to date!</p>
          )}
          <ul className="divide-y divide-border">
            {overdueQuery.data?.map((l) => (
              <li key={String(l.id)} className="py-2 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/leads/${String(l.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                    {String(l.company)}
                  </Link>
                  <span className="text-red font-mono text-[11px] font-medium">
                    Overdue ({String(l.next_action_date)})
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted line-clamp-2">
                  {String(l.next_action_note || 'Follow-up call or proposal update required.')}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
