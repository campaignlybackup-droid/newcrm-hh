'use client';

import { cn } from '@/lib/utils';
import { STATUS_TONE } from '@/modules/enums';
import { initials } from '@/lib/utils';
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from 'react';

/* ---------------------------------------------------------------- Button */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'md';
};
export function Button({ variant = 'outline', size = 'sm', className, ...p }: ButtonProps) {
  return (
    <button
      {...p}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors',
        'disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent/90',
        variant === 'outline' && 'border border-border bg-surface hover:bg-raised',
        variant === 'ghost' && 'hover:bg-raised text-muted hover:text-fg',
        variant === 'danger' && 'border border-red/40 text-red hover:bg-red/10',
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------ Chip */
export function StatusChip({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return <span className="text-muted">—</span>;
  const tone = STATUS_TONE[value] ?? 'neutral';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
        tone === 'neutral' && 'bg-raised text-muted',
        tone === 'info' && 'bg-accent/12 text-accent',
        tone === 'good' && 'bg-green/12 text-green',
        tone === 'warn' && 'bg-amber/15 text-amber',
        tone === 'bad' && 'bg-red/12 text-red',
        className,
      )}
    >
      {value}
    </span>
  );
}

export function HealthDot({ value }: { value?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span className={cn('h-2 w-2 rounded-full',
        value === 'Green' && 'bg-green', value === 'Amber' && 'bg-amber',
        value === 'Red' && 'bg-red', !value && 'bg-border')} />
      {value ?? '—'}
    </span>
  );
}

/* ---------------------------------------------------------------- Avatar */
export function Avatar({ name, url, size = 22 }: { name?: string | null; url?: string | null; size?: number }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={name ?? ''} width={size} height={size}
         className="rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span
      className="inline-flex items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-muted"
      style={{ width: size, height: size }}
      title={name ?? undefined}
    >
      {initials(name)}
    </span>
  );
}

export function UserCell({ user }: { user?: { full_name?: string; avatar_url?: string | null } | null }) {
  if (!user?.full_name) return <span className="text-muted">Unassigned</span>;
  return (
    <span className="inline-flex items-center gap-1.5 truncate">
      <Avatar name={user.full_name} url={user.avatar_url} />
      <span className="truncate">{user.full_name}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- Inputs */
export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...p}
      className={cn('h-8 w-full rounded-md border border-border bg-surface px-2 text-[13px]',
        'outline-none focus:ring-2 focus:ring-accent/50', p.className)} />
  );
}

export function Select({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p}
      className={cn('h-8 w-full rounded-md border border-border bg-surface px-2 text-[13px]',
        'outline-none focus:ring-2 focus:ring-accent/50', p.className)}>
      {children}
    </select>
  );
}

/* ----------------------------------------------------------------- Misc */
export function Card({ title, action, children, className }:
  { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone, hint }:
  { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad'; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums',
        tone === 'good' && 'text-green', tone === 'warn' && 'text-amber', tone === 'bad' && 'text-red')}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-md text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-accent" />
      {label ?? 'Loading'}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-md border border-red/30 bg-red/5 px-3 py-2 text-[13px] text-red">
      {msg}
    </div>
  );
}
