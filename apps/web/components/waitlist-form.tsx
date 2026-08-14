'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { joinWaitlist, ServiceError } from '@/lib/api';
import { cn } from '@/lib/utils';

type Status = 'empty' | 'submitting' | 'joined' | 'already' | 'invalid' | 'failed';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The conversion. Everything else on the page exists to get someone here.
 *
 * Validates before submitting so the common mistake costs no round trip, and
 * treats "already on the list" as an ordinary outcome rather than an error —
 * being told off for joining twice is a bad way to meet someone.
 */
export function WaitlistForm({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('empty');
  const [problem, setProblem] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();

    if (!EMAIL.test(address)) {
      setStatus('invalid');
      setProblem('That address is missing an @ or a domain. Check it and submit again.');
      return;
    }

    setStatus('submitting');
    try {
      setStatus(await joinWaitlist(address));
    } catch (error) {
      setStatus('failed');
      setProblem(
        error instanceof ServiceError
          ? error.message
          : 'We could not reach the waitlist. Try again in a moment.',
      );
    }
  }

  if (status === 'joined' || status === 'already') {
    return (
      <div className="border-border bg-card animate-[rise_0.25s_ease-out] border p-4">
        <p className="text-card-foreground font-medium">
          {status === 'already' ? "You're already on the list" : "You're on the list"}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          {status === 'already'
            ? 'No need to join twice. We email once, when filling works.'
            : 'We email once, when filling works. Nothing before that.'}
        </p>
        <p className="text-muted-foreground mt-2 font-mono text-xs break-all">{email.trim()}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => {
            setEmail('');
            setStatus('empty');
          }}
        >
          Use a different address
        </Button>
      </div>
    );
  }

  const broken = status === 'invalid' || status === 'failed';

  return (
    <form onSubmit={submit} noValidate>
      <div className={cn('flex gap-2', compact ? 'flex-nowrap' : 'flex-wrap')}>
        <Input
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (broken) setStatus('empty');
          }}
          placeholder="you@work.com"
          spellCheck={false}
          aria-label="Email address"
          aria-invalid={broken}
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={status === 'submitting'} className="shrink-0">
          {status === 'submitting' ? 'Joining…' : compact ? 'Join' : 'Join the waitlist'}
        </Button>
      </div>
      {broken && (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {problem}
        </p>
      )}
    </form>
  );
}
