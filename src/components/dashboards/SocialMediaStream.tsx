'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { Card, Spinner, StatusChip, Empty } from '@/components/ui/primitives';

export function SocialMediaStream() {
  // Query 1: Content Calendar Posts Stream
  const postsQuery = useQuery({
    queryKey: ['social_dashboard', 'posts'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('content_calendar')
        .select('*, client:clients(brand_name)')
        .is('deleted_at', null)
        .order('post_date', { ascending: true })
        .limit(15);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Query 2: Active Campaigns
  const campaignsQuery = useQuery({
    queryKey: ['social_dashboard', 'campaigns'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('campaigns')
        .select('*, client:clients(brand_name)')
        .is('deleted_at', null)
        .order('end_date', { ascending: true })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <div className="space-y-4 col-span-full lg:col-span-2">
      {/* Social Media Suite Header */}
      <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
        <h2 className="text-sm font-semibold text-accent flex items-center gap-2">
          <span>📱</span> Social Media & Content Publishing Hub
        </h2>
        <p className="mt-1 text-xs text-muted">
          Track upcoming scheduled posts, platform channels, caption approvals, and active campaigns.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Content Stream Panel */}
        <Card
          title="Scheduled Content Calendar"
          action={<Link href="/content_calendar" className="text-[12px] text-accent hover:underline">All Posts</Link>}
        >
          {postsQuery.isLoading && <Spinner />}
          {postsQuery.data && !postsQuery.data.length && <Empty title="No content scheduled" />}
          <ul className="divide-y divide-border">
            {postsQuery.data?.map((p) => {
              const platform = String(p.platform ?? 'Social');
              return (
                <li key={String(p.id)} className="py-2 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/content_calendar/${String(p.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                      {String(p.title ?? p.caption ?? 'Untitled Post')}
                    </Link>
                    <StatusChip value={String(p.status ?? 'Draft')} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase font-mono font-medium text-foreground">
                        {platform}
                      </span>
                      <span>{String((p.client as { brand_name?: string })?.brand_name ?? '—')}</span>
                    </span>
                    <span className="tabular-nums font-mono">
                      {String(p.post_date ?? 'Unscheduled')}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Active Campaigns Panel */}
        <Card
          title="Active Social Campaigns"
          action={<Link href="/campaigns" className="text-[12px] text-accent hover:underline">All Campaigns</Link>}
        >
          {campaignsQuery.isLoading && <Spinner />}
          {campaignsQuery.data && !campaignsQuery.data.length && (
            <p className="text-[13px] text-muted py-2">No active campaigns running.</p>
          )}
          <ul className="divide-y divide-border">
            {campaignsQuery.data?.map((c) => (
              <li key={String(c.id)} className="py-2 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/campaigns/${String(c.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                    {String(c.name ?? 'Campaign')}
                  </Link>
                  <StatusChip value={String(c.status ?? 'Planned')} />
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                  <span>{String((c.client as { brand_name?: string })?.brand_name ?? '—')}</span>
                  <span className="tabular-nums font-mono">
                    {String(c.start_date ?? '')} → {String(c.end_date ?? '')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
