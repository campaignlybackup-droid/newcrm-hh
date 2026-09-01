'use client';

import { useEffect, useState } from 'react';
import { Button } from './primitives';

/**
 * Every mutation lands here. An action that changed data offers an Undo
 * for ten seconds; the undo issues a real inverse write, which is itself
 * audited — nothing is quietly reverted behind the log's back.
 */
export interface ToastItem {
  id: number;
  message: string;
  tone?: 'info' | 'error';
  undo?: () => Promise<void> | void;
}

type Listener = (t: ToastItem) => void;
const listeners = new Set<Listener>();
let seq = 0;

export function pushToast(message: string, tone: 'info' | 'error' = 'info') {
  const item: ToastItem = { id: ++seq, message, tone };
  listeners.forEach((l) => l(item));
}

export function pushUndo({ message, undo }: { message: string; undo: () => Promise<void> | void }) {
  const item: ToastItem = { id: ++seq, message, undo };
  listeners.forEach((l) => l(item));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener: Listener = (t) => {
      setItems((cur) => [...cur, t]);
      const ttl = t.undo ? 10_000 : 4_000;
      setTimeout(() => setItems((cur) => cur.filter((i) => i.id !== t.id)), ttl);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  if (!items.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {items.map((t) => (
        <div key={t.id}
          className={`pointer-events-auto flex items-center gap-3 rounded-lg border px-3.5 py-2 text-[13px] shadow-lg
            ${t.tone === 'error'
              ? 'border-red/40 bg-red/10 text-red'
              : 'border-border bg-surface text-fg'}`}>
          <span>{t.message}</span>
          {t.undo && (
            <Button
              variant="ghost"
              className="h-6 px-1.5 text-accent"
              onClick={async () => {
                setItems((cur) => cur.filter((i) => i.id !== t.id));
                try { await t.undo!(); pushToast('Change undone'); }
                catch (e) { pushToast(e instanceof Error ? e.message : 'Undo failed', 'error'); }
              }}
            >
              Undo
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
