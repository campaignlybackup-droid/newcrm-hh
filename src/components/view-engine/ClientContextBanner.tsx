'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { HealthDot } from '@/components/ui/primitives';

interface ClientContextBannerProps {
  clientId: string;
}

export function ClientContextBanner({ clientId }: ClientContextBannerProps) {
  const { data: client, isLoading } = useQuery({
    queryKey: ['client_context', clientId],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('v_client_context')
        .select('*')
        .eq('client_id', clientId)
        .maybeSingle();
      if (error) throw error;
      return data as Record<string, unknown> | null;
    },
    enabled: Boolean(clientId),
  });

  if (!clientId) return null;
  if (isLoading) return <div className="rounded-lg border border-border bg-surface p-3 text-xs text-muted">Loading client details…</div>;
  if (!client) return null;

  const hexColors: string[] = Array.isArray(client.colour_hex_list) ? (client.colour_hex_list as string[]) : [];
  const fonts: string[] = Array.isArray(client.fonts) ? (client.fonts as string[]) : [];

  const accountManagerName = client.account_manager_name ? String(client.account_manager_name) : null;
  const brandGuidelineUrl = client.brand_guideline_url ? String(client.brand_guideline_url) : null;
  const primaryContactName = client.primary_contact_name ? String(client.primary_contact_name) : null;
  const primaryContactEmail = client.primary_contact_email ? String(client.primary_contact_email) : null;
  const primaryContactPhone = client.primary_contact_phone ? String(client.primary_contact_phone) : null;
  const toneNotes = client.tone_of_voice_notes ? String(client.tone_of_voice_notes) : null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface/90 p-3.5 shadow-sm transition-colors hover:border-border/80">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
        <div className="flex items-center gap-2.5">
          <HealthDot value={String(client.health ?? 'Green')} />
          <Link href={`/clients/${clientId}`} className="font-medium text-foreground hover:text-accent hover:underline">
            {String(client.brand_name ?? 'Client Context')}
          </Link>
          <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-mono uppercase text-muted">
            {String(client.client_code ?? '')}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-muted">
          {accountManagerName && (
            <span>AM: <strong className="font-normal text-foreground">{accountManagerName}</strong></span>
          )}
          {brandGuidelineUrl && (
            <a
              href={brandGuidelineUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline font-medium"
            >
              <span>Brand Guidelines ↗</span>
            </a>
          )}
        </div>
      </div>

      <div className="mt-2.5 grid gap-3 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
        {/* Primary Contact */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Primary Contact</span>
          <div className="mt-0.5 font-medium text-foreground">
            {primaryContactName ?? 'No primary contact'}
          </div>
          {primaryContactEmail && (
            <div className="text-muted truncate">{primaryContactEmail}</div>
          )}
          {primaryContactPhone && (
            <div className="text-muted">{primaryContactPhone}</div>
          )}
        </div>

        {/* Brand Palette */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Brand Palette</span>
          <div className="mt-1 flex items-center gap-1.5">
            {hexColors.length > 0 ? (
              hexColors.map((hex, i) => (
                <div
                  key={i}
                  className="h-5 w-5 rounded border border-border shadow-xs"
                  style={{ backgroundColor: hex }}
                  title={hex}
                />
              ))
            ) : (
              <span className="text-muted">No colors specified</span>
            )}
          </div>
        </div>

        {/* Brand Fonts */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Typography</span>
          <div className="mt-0.5 font-medium text-foreground">
            {fonts.length > 0 ? fonts.join(', ') : 'Standard Sans'}
          </div>
        </div>

        {/* Tone of Voice */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Tone & Voice</span>
          <div className="mt-0.5 line-clamp-2 text-muted" title={toneNotes ?? ''}>
            {toneNotes ?? 'Standard agency tone guidelines.'}
          </div>
        </div>
      </div>
    </div>
  );
}
