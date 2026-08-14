import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'untitled',
  description:
    'Paste a url. See every box on the page, what each one is really called, and which ones we could fill for you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
