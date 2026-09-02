'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, supabaseDynamic } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Card, Spinner, StatusChip, Button, Avatar } from '@/components/ui/primitives';
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

  const [editStatus, setEditStatus] = useState<FounderAvailabilityData['status']>('Available');
  const [editNote, setEditNote] = useState<string>('');
  const [editLocation, setEditLocation] = useState<string>('Dubai HQ');
  const [showEditDrawer, setShowEditDrawer] = useState<boolean>(false);

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

  useEffect(() => {
    if (data) {
      setEditStatus(data.status);
      setEditNote(data.status_note ?? '');
      setEditLocation(data.location ?? 'Dubai HQ');
    }
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: async ({
      status,
      note,
      location,
    }: {
      status: FounderAvailabilityData['status'];
      note: string;
      location: string;
    }) => {
      if (!data?.id) {
        const { error } = await supabaseDynamic()
          .from('founder_availability')
          .insert({
            status,
            status_note: note,
            location,
            updated_by: session?.user.id,
          });
        if (error) throw error;
      } else {
        const { error } = await supabaseDynamic()
          .from('founder_availability')
          .update({
            status,
            status_note: note,
            location,
            updated_at: new Date().toISOString(),
            updated_by: session?.user.id,
          })
          .eq('id', data.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      pushToast('Founder availability & schedule updated live!');
      setShowEditDrawer(false);
      queryClient.invalidateQueries({ queryKey: ['founder_availability'] });
    },
    onError: (err) => {
      pushToast(err instanceof Error ? err.message : 'Update failed', 'error');
    },
  });

  if (availabilityQuery.isLoading) return <Spinner label="Loading Founder availability..." />;

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

  const statusColors = {
    Available: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    'In Meeting': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    Busy: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    'Out of Office': 'bg-sky-500/20 text-sky-400 border-sky-500/30',
    'On Leave': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  };

  const statusIcons = {
    Available: '🟢',
    'In Meeting': '🟡',
    Busy: '🔴',
    'Out of Office': '✈️',
    'On Leave': '🌴',
  };

  return (
    <div className="col-span-full rounded-lg border border-border bg-surface p-4 space-y-3">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Avatar name="Founder Ira" size={36} />
            <span className="absolute -bottom-1 -right-1 text-xs">
              {statusIcons[status]}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span>👑</span> Founder&apos;s Live Availability &amp; Open Office Hours
            </h3>
            <p className="text-xs text-muted truncate max-w-[450px]">
              {statusNote} · <span className="font-mono text-foreground">{location}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium flex items-center gap-1.5', statusColors[status])}>
            <span>{statusIcons[status]}</span>
            <span>{status}</span>
          </span>

          {isFounder && (
            <Button variant="outline" size="sm" onClick={() => setShowEditDrawer(true)}>
              ✏️ Update Availability
            </Button>
          )}
        </div>
      </div>

      {/* Weekly Schedule Grid */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
        {slots.map((s) => (
          <div
            key={s.day}
            className={cn(
              'rounded-md border p-2.5 text-xs transition-colors',
              s.working ? 'border-border bg-raised' : 'border-border/40 bg-surface opacity-50'
            )}
          >
            <div className="flex items-center justify-between font-medium text-foreground">
              <span>{s.day}</span>
              <span className="text-[10px] font-mono text-muted">
                {s.working ? `${s.start} - ${s.end}` : 'Off'}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-accent font-mono truncate" title={s.open_hours}>
              {s.open_hours}
            </p>
          </div>
        ))}
      </div>

      {/* Founder Live Control Drawer */}
      {showEditDrawer && isFounder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <Card title="Update Founder Real-time Availability" className="w-full max-w-md bg-surface border-border shadow-xl">
            <div className="space-y-4 pt-2 text-xs">
              <div>
                <label className="block text-muted mb-1.5 font-medium">Select Real-Time Status:</label>
                <div className="flex flex-wrap gap-1.5">
                  {(['Available', 'In Meeting', 'Busy', 'Out of Office', 'On Leave'] as const).map((st) => (
                    <button
                      key={st}
                      onClick={() => setEditStatus(st)}
                      className={cn(
                        'rounded border px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1',
                        editStatus === st ? statusColors[st] : 'border-border bg-raised text-muted hover:text-foreground'
                      )}
                    >
                      <span>{statusIcons[st]}</span>
                      <span>{st}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-muted mb-1 font-medium">Status Note for Team:</label>
                <input
                  type="text"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder="e.g. In Client Shoot at Dubai Marina until 4 PM"
                  className="w-full rounded border border-border bg-raised p-2 text-xs text-foreground focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-muted mb-1 font-medium">Current Location:</label>
                <input
                  type="text"
                  value={editLocation}
                  onChange={(e) => setEditLocation(e.target.value)}
                  placeholder="e.g. Dubai HQ (GST UTC+4)"
                  className="w-full rounded border border-border bg-raised p-2 text-xs text-foreground focus:border-accent focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <Button variant="ghost" size="sm" onClick={() => setShowEditDrawer(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={updateMutation.isPending}
                  onClick={() =>
                    updateMutation.mutate({
                      status: editStatus,
                      note: editNote,
                      location: editLocation,
                    })
                  }
                >
                  {updateMutation.isPending ? 'Updating...' : 'Publish Status Live'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
