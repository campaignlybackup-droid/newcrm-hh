'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabaseDynamic } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Spinner, Avatar, Button } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import { cn } from '@/lib/utils';

interface WeeklySlot {
  day: string;
  working: boolean;
  start: string | null;
  end: string | null;
  open_hours: string;
}

interface FounderAvailabilityData {
  id: string;
  status: 'Available' | 'In Meeting' | 'Busy' | 'Out of Office' | 'On Leave';
  status_note: string | null;
  location: string | null;
  timezone: string;
  weekly_slots: WeeklySlot[];
  updated_at: string;
}

export function FounderAvailabilityCalendar() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const isFounder = (session?.role?.level ?? 99) <= 1;

  const [noteEdit, setNoteEdit] = useState<string>('');
  const [isEditingNote, setIsEditingNote] = useState<boolean>(false);

  const availabilityQuery = useQuery({
    queryKey: ['founder_availability'],
    queryFn: async () => {
      const { data, error } = await supabaseDynamic()
        .from('founder_availability')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as FounderAvailabilityData | null;
    },
  });

  const data = availabilityQuery.data;

  const updateStatusMutation = useMutation({
    mutationFn: async ({
      status,
      note,
      location,
    }: {
      status: FounderAvailabilityData['status'];
      note?: string;
      location?: string;
    }) => {
      if (!data?.id) {
        const { error } = await supabaseDynamic()
          .from('founder_availability')
          .insert({
            status,
            status_note: note ?? 'In Office — Open for strategy & approvals',
            location: location ?? 'Dubai HQ (GST UTC+4)',
            updated_by: session?.user.id,
          });
        if (error) throw error;
      } else {
        const { error } = await supabaseDynamic()
          .from('founder_availability')
          .update({
            status,
            status_note: note ?? data.status_note,
            location: location ?? data.location,
            updated_at: new Date().toISOString(),
            updated_by: session?.user.id,
          })
          .eq('id', data.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      pushToast('Founder availability updated live!');
      setIsEditingNote(false);
      queryClient.invalidateQueries({ queryKey: ['founder_availability'] });
    },
    onError: (err) => {
      pushToast(err instanceof Error ? err.message : 'Update failed', 'error');
    },
  });

  if (availabilityQuery.isLoading) return <Spinner label="Loading Founder status..." />;

  const status = data?.status ?? 'Available';
  const statusNote = data?.status_note ?? 'In Office — Open for strategy & approvals';
  const location = data?.location ?? 'Dubai HQ (GST UTC+4)';
  const slots: WeeklySlot[] = data?.weekly_slots ?? [
    { day: 'Monday', working: true, start: '10:00', end: '19:00', open_hours: '14:00 - 16:00 (Team Sync)' },
    { day: 'Tuesday', working: true, start: '10:00', end: '19:00', open_hours: '15:00 - 17:00 (Client Reviews)' },
    { day: 'Wednesday', working: true, start: '10:00', end: '19:00', open_hours: '11:00 - 13:00 (Strategy)' },
    { day: 'Thursday', working: true, start: '10:00', end: '19:00', open_hours: '14:00 - 16:00 (Approvals)' },
    { day: 'Friday', working: true, start: '10:00', end: '17:00', open_hours: '11:00 - 14:00 (Open Door)' },
    { day: 'Saturday', working: false, start: null, end: null, open_hours: 'Weekend' },
    { day: 'Sunday', working: false, start: null, end: null, open_hours: 'Weekend' },
  ];

  // Determine Today's Open Hours
  const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayName = daysOfWeek[new Date().getDay()];
  const todaySlot = slots.find((s) => s.day === todayName) ?? slots[1];

  const statusConfig = {
    Available: { bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', icon: '🟢', label: 'AVAILABLE NOW' },
    'In Meeting': { bg: 'bg-amber-500/10 border-amber-500/30 text-amber-400', icon: '🟡', label: 'IN CLIENT MEETING' },
    Busy: { bg: 'bg-rose-500/10 border-rose-500/30 text-rose-400', icon: '🔴', label: 'BUSY / FOCUS MODE' },
    'Out of Office': { bg: 'bg-sky-500/10 border-sky-500/30 text-sky-400', icon: '✈️', label: 'OUT OF OFFICE' },
    'On Leave': { bg: 'bg-purple-500/10 border-purple-500/30 text-purple-400', icon: '🌴', label: 'ON LEAVE' },
  };

  const currentConfig = statusConfig[status] ?? statusConfig.Available;

  return (
    <div className="col-span-full rounded-xl border border-border bg-surface p-4 shadow-sm space-y-3">
      {/* Top Banner & Status Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Avatar name="Founder Ira" size={38} />
            <span className="absolute -bottom-1 -right-1 text-sm">
              {currentConfig.icon}
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                Founder&apos;s Live Availability
              </h3>
              <span className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-mono font-bold tracking-wide', currentConfig.bg)}>
                {currentConfig.icon} {currentConfig.label}
              </span>
            </div>
            
            {!isEditingNote ? (
              <p className="text-xs text-muted mt-0.5 flex items-center gap-2">
                <span>{statusNote}</span>
                <span className="text-muted/60">·</span>
                <span className="font-mono text-foreground/80">{location}</span>
                {isFounder && (
                  <button
                    onClick={() => {
                      setNoteEdit(statusNote);
                      setIsEditingNote(true);
                    }}
                    className="text-[11px] text-accent hover:underline ml-1"
                  >
                    Edit Note
                  </button>
                )}
              </p>
            ) : (
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  value={noteEdit}
                  onChange={(e) => setNoteEdit(e.target.value)}
                  className="rounded border border-border bg-raised px-2 py-0.5 text-xs text-foreground focus:border-accent focus:outline-none w-72"
                  placeholder="Enter status note..."
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={updateStatusMutation.isPending}
                  onClick={() => updateStatusMutation.mutate({ status, note: noteEdit })}
                >
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setIsEditingNote(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* 1-Click Founder Status Switcher (Renders on Card for Founder) */}
        {isFounder && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-raised p-1 text-xs">
            <span className="px-1.5 text-[10px] font-mono text-muted uppercase">Set Status:</span>
            {(['Available', 'In Meeting', 'Busy', 'Out of Office'] as const).map((st) => (
              <button
                key={st}
                onClick={() => updateStatusMutation.mutate({ status: st })}
                disabled={updateStatusMutation.isPending}
                className={cn(
                  'rounded px-2 py-1 font-medium transition-all text-xs flex items-center gap-1',
                  status === st
                    ? 'bg-surface text-foreground shadow-xs border border-border font-semibold'
                    : 'text-muted hover:text-foreground'
                )}
              >
                <span>{statusConfig[st].icon}</span>
                <span>{st}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Today's Open Discussion Slot Callout */}
      <div className="rounded-lg border border-accent/20 bg-accent/5 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">📅 Today ({todayName}):</span>
          <span className="text-foreground">
            {todaySlot.working ? (
              <>Working <span className="font-mono text-accent">{todaySlot.start} – {todaySlot.end} GST</span></>
            ) : (
              <span className="text-muted">Off (Weekend)</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-muted font-mono">
          <span>Open Slot:</span>
          <span className="rounded bg-raised px-2 py-0.5 text-accent font-semibold">
            {todaySlot.open_hours}
          </span>
        </div>
      </div>

      {/* Clean 5-Day Weekly Strip */}
      <div className="grid grid-cols-5 gap-1.5 text-[11px]">
        {slots.filter(s => s.working).map((s) => (
          <div
            key={s.day}
            className={cn(
              'rounded-md border border-border/60 bg-raised/50 p-2 flex items-center justify-between',
              s.day === todayName && 'border-accent/40 bg-accent/5'
            )}
          >
            <span className="font-medium text-foreground">{s.day.slice(0, 3)}</span>
            <span className="font-mono text-muted text-[10px]">{s.start} - {s.end}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
