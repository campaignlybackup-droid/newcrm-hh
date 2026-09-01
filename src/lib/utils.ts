import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function initials(name?: string | null) {
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

export function titleCase(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
