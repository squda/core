import { ReadDemo } from '@/components/read-demo';
import { WaitlistForm } from '@/components/waitlist-form';
import { Separator } from '@/components/ui/separator';

/**
 * The waitlist page.
 *
 * A server component holding the copy, with the two interactive parts — the
 * demo and the signup — as islands. The demo is the argument: nobody joins a
 * waitlist for form filling on a promise, but they might after watching it read
 * a page they chose themselves.
 */
export default function Home() {
  return (
    <div className="mx-auto min-h-screen max-w-7xl px-5">
      <header className="flex flex-wrap items-center justify-between gap-4 py-8">
        {/* The mark carried the S. With it gone the wordmark has to spell the name itself. */}
        <span className="text-sm font-semibold tracking-[0.12em] uppercase">squda</span>
        {/*
         * The badge describes what the product does, not what it lacks. The
         * roadmap has its own section further down; the masthead is the wrong
         * place to spend on a caveat, and the demo below proves this claim
         * within one paste.
         */}
        <span className="text-muted-foreground font-mono text-xs">
          reads any form · names every field
        </span>
      </header>

      <Separator />

      <section className="grid items-end gap-14 py-16 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <h1 className="text-4xl leading-[0.98] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Every form asks for the same things. Nothing agrees what to call them.
          </h1>
          <p className="text-muted-foreground mt-6 max-w-[46ch] text-base text-pretty">
            Paste a url below. You get the page as clean markdown, and every box on it — what it is
            called, what type it is, and how sure we are that we know its name.
          </p>
        </div>
        <div>
          <p className="text-muted-foreground mb-3 font-mono text-[11px] tracking-widest uppercase">
            Join the waitlist
          </p>
          <WaitlistForm />
          <p className="text-muted-foreground mt-3 text-sm">
            One email the day filling ships. Nothing else.
          </p>
        </div>
      </section>

      <Separator />

      <ReadDemo />

      <Separator className="mt-20" />

      <section className="grid gap-10 py-16 sm:grid-cols-2">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Next filling</h2>
          <p className="text-muted-foreground mt-4 max-w-[56ch] text-pretty">
            You answer the handful of facts every form asks for once, and the next form gets them
            typed in for you — shown to you filled in, and never submitted until you say so. The
            waitlist is how you hear when it ships.
          </p>
        </div>
        <div>
          <p className="text-muted-foreground mb-3 font-mono text-[11px] tracking-widest uppercase">
            Same fact, three pages
          </p>
          <div className="border-border divide-border divide-y border">
            {[
              { label: 'Certificate/License Number', source: 'label-for' },
              { label: 'License #', source: 'placeholder' },
              { label: 'no name on the page', source: '(none)', faded: true },
            ].map((row) => (
              <div
                key={row.source}
                className="flex items-baseline text-sm justify-between gap-4 p-3.5"
              >
                <span className={row.faded ? 'text-muted-foreground italic' : ''}>{row.label}</span>
                <span className="text-muted-foreground font-mono text-[11px] whitespace-nowrap">
                  {row.source}
                </span>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground mt-3 text-sm">
            One fact. Three pages. Three names — and one page that never says.
          </p>
        </div>
      </section>

      <Separator />

      <footer className="text-muted-foreground flex flex-wrap justify-between gap-6 py-8 font-mono text-xs">
        <span>built by makeagent</span>
        <span>reads any form · names every field</span>
      </footer>
    </div>
  );
}
