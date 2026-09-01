'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, Button, Avatar, Spinner } from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { pushToast } from '@/components/ui/Toaster';

/**
 * Comments are immutable once posted: editing one leaves a visible
 * revision (enforced by a database trigger, not by this component).
 * Internal comments never reach the client portal — RLS drops them.
 */
export function Comments({ entityType, entityId, clientId }: {
  entityType: string; entityId: string; clientId: string | null;
}) {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(true);

  const comments = useQuery({
    queryKey: ['comments', entityType, entityId],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('comments')
        .select('*, author:users!comments_author_id_fkey(id,full_name,avatar_url)')
        .eq('entity_type', entityType).eq('entity_id', entityId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const post = useMutation({
    mutationFn: async () => {
      const { error } = await supabase().from('comments').insert({
        entity_type: entityType, entity_id: entityId, client_id: clientId,
        body, is_internal: internal, author_id: session?.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setBody('');
      qc.invalidateQueries({ queryKey: ['comments', entityType, entityId] });
    },
    onError: (e) => pushToast(e instanceof Error ? e.message : 'Could not post', 'error'),
  });

  return (
    <Card title="Comments">
      {comments.isLoading && <Spinner />}
      <ul className="space-y-3">
        {comments.data?.map((c) => {
          const author = c.author as { full_name?: string; avatar_url?: string | null } | null;
          return (
            <li key={String(c.id)} className="flex gap-2.5">
              <Avatar name={author?.full_name} url={author?.avatar_url} size={26} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-2 text-[12px]">
                  <span className="font-medium">{author?.full_name ?? 'Unknown'}</span>
                  <span className="text-muted">{new Date(String(c.created_at)).toLocaleString()}</span>
                  {!c.is_internal && <span className="rounded bg-accent/12 px-1 text-[10px] text-accent">visible to client</span>}
                  {c.edited_at != null && <span className="text-[10px] text-muted">edited</span>}
                </p>
                <p className="whitespace-pre-wrap text-[13px]">{String(c.body)}</p>
              </div>
            </li>
          );
        })}
        {comments.data && !comments.data.length && (
          <li className="text-[13px] text-muted">No comments yet.</li>
        )}
      </ul>

      <div className="mt-3 space-y-2 border-t border-border pt-3">
        <textarea value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment. Use @ to mention someone."
          className="min-h-[70px] w-full rounded-md border border-border bg-surface p-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/50" />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)}
              className="h-3.5 w-3.5 accent-[rgb(var(--accent))]" />
            Internal only
          </label>
          <Button variant="primary" disabled={!body.trim() || post.isPending} onClick={() => post.mutate()}>
            Post
          </Button>
        </div>
        <p className="text-[11px] text-muted">
          Comments cannot be silently edited — a change is stored as a visible revision.
        </p>
      </div>
    </Card>
  );
}
