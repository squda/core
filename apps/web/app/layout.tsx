import type { Metadata } from 'next';
import './globals.css';
import { Figtree, IBM_Plex_Mono } from 'next/font/google';
import { cn } from '@/lib/utils';

const figtree = Figtree({ subsets: ['latin'], variable: '--font-sans' });

/**
 * Selectors, label sources and field types are machine text — `#question_36101208002`
 * is unreadable in a proportional face, and the eye needs to tell it apart from
 * the human-written label sitting directly above it.
 */
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Squda — read any form',
  description:
    'Paste a url. Get the page as clean markdown, and every box on it — what it is called, and how sure we are that we know its name.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn('font-sans', figtree.variable, mono.variable)}>
      <body>{children}</body>
    </html>
  );
}
