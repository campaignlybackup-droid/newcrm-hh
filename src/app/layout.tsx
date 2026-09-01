import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Agency Operations',
  description: 'Clients, projects, deliverables, shoots and content — one source of truth.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen antialiased bg-bg text-fg">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
