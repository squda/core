# Design brief — paste this into Claude

Everything below the rule is self-contained. Copy from there to the end.

---

## The brief

I need a design for a **single waitlist page** with two live demos on it. Below is the product, the
real data both demos produce, and the constraints. Please read all of it before proposing anything.

### What I'm building

A tool that reads any web page and then fills its forms in for you.

Two halves, and both work today:

1. **Read a page.** Url in, clean Markdown out — the article without the navigation, the cookie
   banner, the newsletter box or the footer. If the page builds itself with JavaScript, it opens a
   real browser and waits.
2. **Read a page's _forms_.** Every box on the page: what it's called, what type it is, and — the
   important part — **how confident we are that we know what it's called.**

The second half is on its way to becoming the actual product: remember your answers once, and have
them typed into the next form for you. **That is not built yet**, and the page must not pretend
otherwise. What the demo shows is _what we could fill_, not filling.

The insight the whole thing rests on: **every form asks for the same handful of facts, and no two
forms agree on what to call them.** One site says "Certificate/License Number", another says
"License #", a third says nothing at all and shows an empty box.

### What this page is for

A **waitlist page**. Three jobs, in this order of importance:

1. **Get the email address.** This is the conversion. Everything else serves it.
2. **Prove it's real** — with two demos that run live on a url the visitor chooses. Not screenshots,
   not a video. They paste their own url and watch it work. That's the whole reason a waitlist for
   this can convert at all.
3. **Explain what's coming** — the filling, which doesn't exist yet.

The visitor is someone who fills a lot of similar forms: job applications, licence renewals, grant
portals, supplier registrations. Semi-technical, not a developer. The question in their head is
_"would this actually work on my forms?"_ — and the demo is what answers it.

**A structural suggestion, take it or leave it:** it's one url input, and both demos read the same
page. "Here's one url — here's the text we got out of it, and here's every box we found on it." That
tells the story better than two separate widgets, but decide for yourself.

---

## Demo 1 — reading the page

Paste a url, get clean Markdown, plus the title, description, links and images.

**Real output, measured just now:**

| page                 | time  | markdown         | links   | images | notes                                                                              |
| -------------------- | ----- | ---------------- | ------- | ------ | ---------------------------------------------------------------------------------- |
| a personal blog post | 927ms | 1,600 chars      | 8       | 1      | description: "Come waste your time with me."                                       |
| a Wikipedia article  | 876ms | **49,895 chars** | **300** | 0      | detected an RSS feed and JSON-LD `Article` data                                    |
| a React docs page    | 722ms | 16,942 chars     | 26      | 8      | —                                                                                  |
| an SPA (Excalidraw)  | ~3s   | 556 chars        | —       | —      | plain fetch returned an empty `<div id="root">`, so it re-opened in a real browser |

So the Markdown panel has to handle **1,600 characters and 49,895 characters** with equal grace, and
a link list that can be 8 items or 300.

Each result also carries: whether it came via `http` or a real `browser`, whether the page published
an RSS feed, whether it had JSON-LD structured data, and a `wall` flag when the page is behind a
**login, a captcha, or a consent banner** — that last one is worth surfacing, because "we got the
page but it's a cookie wall" is different from "we got the page".

**Real failure, and the error text we already produce:**

> `403` — blocked by bot protection. A browser retry does not help — look for an API, a data dump,
> or another source.

Stack Overflow, Quora and Medium all refuse us. That's a normal outcome, and the design should treat
a refusal as information rather than as a broken page.

---

## Demo 2 — reading the page's forms

Same url, different question: what could we fill in here?

**This is the one that should be memorable, and here is why.** We work out each field's name from
one of several sources, and they are not equally believable:

| source                           | what it means                                                                        | trust  |
| -------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| `label-for`                      | the page names this field outright, the same way it tells a screen reader            | high   |
| `label-wrapping`                 | same, via a wrapping `<label>`                                                       | high   |
| `aria-label` / `aria-labelledby` | named via accessibility attributes                                                   | high   |
| `placeholder`                    | read from the grey text inside the box — written for a different purpose             | medium |
| `title`                          | read from a tooltip                                                                  | medium |
| `nearby-text`                    | there was some text next to it. proximity is not meaning. **this one gets it wrong** | low    |
| _(nothing)_                      | the page never says what this box is. we don't invent a name                         | none   |

Showing this per field shows the visitor the system's own uncertainty — which is the honest answer to
"would it work on my form?", and **no competing autofill tool displays it**. Admitting what we don't
know is what makes the rest believable.

There's a headline number in it: _of the boxes a person actually fills, how many can we name?_

**One field, exactly as the API returns it** (a CV upload on a real job application):

```json
{
  "selector": "#resume",
  "id": "resume",
  "name": null,
  "type": "file",
  "label": "Attach",
  "labelSource": "label-for",
  "description": null,
  "autocomplete": null,
  "required": false,
  "disabled": false,
  "readonly": false,
  "sensitive": false,
  "placeholder": null,
  "options": [],
  "accept": ".pdf,.doc,.docx,.txt,.rtf",
  "multiple": false,
  "pattern": null,
  "maxLength": null,
  "minLength": null,
  "min": null,
  "max": null,
  "step": null
}
```

`type` is one of: `text email tel url number password date time datetime-local month week search
color range checkbox radio select textarea file hidden custom`. (`custom` = a React widget
pretending to be a form control. Increasingly the normal case — none of our six test pages used a
native `<select>`.)

`sensitive` marks passwords, national IDs, dates of birth, card numbers. It **marks, it does not
block** — those rows want to be instantly spottable, because a person reviewing before submitting
needs to find them.

### Real measurements — design against these, not a tidy mock

**A job application — the realistic "big" case: 22 fields**

- 18 named by `label-for`, 2 by `nearby-text`, **2 with no label at all**
- 11 required, 2 file uploads
- **longest label: 196 characters.** Genuinely this: _"It is important to us to create an accessible
  and inclusive interview experience. Please let us know if there are any adjustments we can make to
  assist you during the hiring and interview process."_
- **longest selector: 145 characters.** Selectors look like `#question_36101208002` or a long CSS
  path. Monospace machine text that must never break the layout.

**A practice form — the messy case: 14 fields**

- only 3 named by `label-for`. **5 from `placeholder`, 4 from `nearby-text`, 2 from nothing.**
- mixed types: text, radio, checkbox, file, textarea; one has a list of options
- Most fields here are _guesses_. This is the case that makes the design worth doing.

**A login form with no labels at all: 2 fields**

- both named from `placeholder`; the password is `sensitive`
- The page must not look broken or empty with only two rows.

**Across a survey of 69 controls:** 25 carried an `autocomplete` token, 19 had help text, **18 had no
label whatsoever**, 8 were hidden. One page contained **five separate forms**.

So it must survive: 2 fields or 22, one form or five, a 196-character label beside a 145-character
selector, and fields with no name at all. A page can also legitimately have **zero forms** — an
empty state, not an error.

---

## The waitlist itself

An email field and a submit. It is the point of the page, so it needs to be reachable without
hunting — think about whether it appears more than once, and what happens after someone submits
(the success state is part of this design, not an afterthought).

Optional, your call: one question alongside the email — _what kind of forms do you fill?_ — because
knowing which industry shows up is genuinely the thing that decides what gets built next. Only worth
it if it doesn't cost conversions.

There's no backend for this yet. Design it; I'll wire it up.

## The states you need to design

**For each demo:** idle · reading (1–8 seconds; slower when a real browser is needed, and the design
should say so rather than just spinning) · read · failed (the service returns a `code` and a
`message` — errors must say what to do next, never apologise).

**For the waitlist:** empty · submitting · joined · already on the list · invalid email.

## Technical constraints

- **Next.js 16, App Router, React 19.** The demo section is a client component.
- **Plain CSS today**, one `globals.css`, nothing committed to. CSS Modules, Tailwind, whatever —
  just say which and why.
- No component library installed. Hand-rolled unless you argue otherwise.
- Must work down to a phone. Wide content — selectors, long labels, code — scrolls inside its own
  container; the page body must never scroll sideways.
- Visible keyboard focus. Respect `prefers-reduced-motion`.
- Dark mode is your call, but if you do it, specify both themes.

## Tone

Plain, specific, unhyped. The product's credibility comes from admitting what it doesn't know, so
never oversell. No "AI-powered", no "revolutionise", no "10x". Active voice, sentence case. An action
keeps its name throughout — if the button says "Read the page", the result says "read".

Working headline, replace it if you can do better:
_"Every form asks for the same things. Nothing agrees what to call them."_

Be honest that filling isn't built yet. That's what the waitlist is for.

## What I don't want

- The generic SaaS landing page: gradient hero, three feature cards with icons, logo cloud, pricing
  table, testimonials from people who don't exist.
- The current AI-design house styles — cream background with a serif display and a terracotta
  accent; near-black with one acid-green accent; fake-broadsheet with hairline rules and no border
  radius. If you land on one, it should be because this brief demanded it, not by default.
- A big number with a small label over a gradient as the hero.
- Decoration that encodes nothing. Numbered steps only if the content is actually a sequence.
- Anything implying the filling works today.

## What I want back

1. **A design plan before any code:** 4–6 named hex values, typefaces for display / body /
   machine-text roles, a layout concept in prose plus a rough ASCII wireframe, and the one signature
   element this page will be remembered by.
2. **Critique your own plan** against this brief — name anything that reads like a default rather
   than a choice made for _this_ product, and revise it.
3. **Then build it as a single self-contained HTML file** with realistic mock data (use the real
   numbers above: the 49,895-character Wikipedia scrape, the 22-field job application, the 14-field
   messy form), showing every state listed. I'll port it into the Next.js app afterwards.

Ask me questions if anything is ambiguous.
