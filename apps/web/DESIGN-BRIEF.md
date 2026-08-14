# Design brief — paste this into Claude

Everything below is self-contained. Copy from the line after this one to the end.

---

## The brief

I need a design for a single web page. Below is everything about the product, the real data the
page renders, and the constraints. Please read all of it before proposing anything.

### What the product is

It reads a web page and reports every form field on it — what each field is called, and **how
confident we are that we know what it's called**. Later it will fill those fields in for you from a
profile you've built up. Right now it only reads; the filling is being built.

The underlying insight, and the reason the product exists: **every form asks for the same handful of
facts, and no two forms agree on what to call them.** One site says "Certificate/License Number",
another says "License #", a third says nothing at all and just shows an empty box. Matching those to
"the thing we know about you" is the hard problem.

### Who uses it and what the page is for

Right now: anyone who fills a lot of similar forms — job applications, licence renewals, grant
portals, supplier registrations. Semi-technical, not developers. They are on this page to answer one
question: **"if I point this at my form, will it actually work?"**

The page has one job: **make someone paste a url**, then answer that question convincingly.

So it is a landing page and a live demo in one. There is no separate marketing site. Results should
appear on the same page.

### The single most important idea in the design

Not the labels. **Where each label came from.**

When we read a page, we work out each field's name from one of these sources, in descending order
of how much we should believe it:

| source                           | what it means                                                                        | trust  |
| -------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| `label-for`                      | the page explicitly names this field, the same way it tells a screen reader          | high   |
| `label-wrapping`                 | same, via a wrapping `<label>`                                                       | high   |
| `aria-label` / `aria-labelledby` | named via accessibility attributes                                                   | high   |
| `placeholder`                    | read from grey text inside the box, written for a different purpose                  | medium |
| `title`                          | read from a tooltip                                                                  | medium |
| `nearby-text`                    | there was some text next to it. proximity is not meaning. **this one gets it wrong** | low    |
| _(nothing)_                      | the page never says what this box is. we do not invent a name                        | none   |

Showing this per field is showing the reader the system's own uncertainty. That is the honest answer
to "will it work on my form?", and **no competing autofill tool displays it.** It should be the thing
the page is remembered for.

There is a headline number in it too: _of the boxes a person actually fills, how many can we name?_

### The real data — this is not hypothetical

One field, exactly as the API returns it (a CV upload on a real job application):

```json
{
  "selector": "#resume",
  "name": null,
  "id": "resume",
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
  "pattern": null,
  "maxLength": null,
  "minLength": null,
  "min": null,
  "max": null,
  "step": null,
  "accept": ".pdf,.doc,.docx,.txt,.rtf",
  "multiple": false
}
```

A page returns a list of forms, each with a list of those. Plus: the url, whether we needed a real
browser to read it (`http` or `browser`), and per form its `method`, its `action`, and the selector
of its submit button.

`type` is one of: `text email tel url number password date time datetime-local month week search
color range checkbox radio select textarea file hidden custom`. (`custom` means a React widget
pretending to be a form control — increasingly the normal case.)

`sensitive` is a flag we set on passwords, national IDs, dates of birth, card numbers. It **marks,
it does not block** — those rows should be visibly called out, because a person reviewing before
submitting needs to spot them instantly.

### Real measurements from real pages — design against these, not against a tidy mock

Measured across the actual test pages:

**A job application (22 fields, the realistic "big" case)**

- 18 named by `label-for`, 2 by `nearby-text`, **2 with no label at all**
- 11 required, 2 file uploads, 0 sensitive
- **longest label: 196 characters.** It is genuinely this: _"It is important to us to create an
  accessible and inclusive interview experience. Please let us know if there are any adjustments we
  can make to assist you during the hiring and interview process."_
- **longest selector: 145 characters.** Selectors are things like `#question_36101208002` or a long
  CSS path. They are monospace machine text and must never break the layout.

**A practice form (14 fields, the messy case)**

- only 3 named by `label-for`. **5 from `placeholder`, 4 from `nearby-text`, 2 with nothing.**
- mixed types: text, radio, checkbox, file, textarea
- one field has a list of options; 1 sensitive; 4 required
- This is the case that makes the design worth doing — most fields here are _guesses_.

**A login form with no labels at all (2 fields)**

- both named from `placeholder`; one sensitive (the password)
- The small case. The page must not look broken or empty with only 2 rows.

**Across a wider survey of 69 controls:** 25 carried an `autocomplete` token, 19 had help text,
**18 had no label whatsoever**, 8 were hidden. One page contained **five separate forms**.

So the design must survive: 2 fields or 22; one form or five; a 196-character label sitting next to
a 145-character selector; and a field with no name at all.

### The four states of the page

1. **Idle** — nothing entered yet. This is the landing state and does the persuading.
2. **Reading** — can take 1–8 seconds. If the page needs a real browser it's slower, and the design
   should say so rather than just spinning.
3. **Read** — results. The main event.
4. **Failed** — the service returns a `code` and a `message`, e.g. `code: "blocked-address"`,
   `message: "refusing to fetch a private address"`. Real failures include: the site refused us, the
   page timed out, it wasn't HTML, the url was invalid. **Errors must say what to do next**, not
   apologise.

Also: a page can legitimately have **zero forms** — that's an empty state, not an error.

### Technical constraints

- **Next.js 16, App Router, React 19.** The page is a client component.
- **Plain CSS today**, in one `globals.css`. Nothing is committed to — CSS Modules, Tailwind, or
  anything else is fine, just say which and why.
- No component library is installed. If your design needs one, say so; otherwise hand-rolled.
- Must work down to a phone. Wide content (selectors, long labels) scrolls inside its own container
  — the page body must never scroll sideways.
- Keyboard focus must be visible. Respect `prefers-reduced-motion`.
- Dark mode: your call, but if you do it, both themes need to be specified.

### Tone

Plain, specific, unhyped. The product's credibility comes from admitting what it doesn't know, so
the copy should never oversell. No "AI-powered", no "revolutionise". Active voice. An action keeps
the same name throughout — if the button says "Read the page", the result says "read".

Current working copy for the headline, which you're free to replace:
_"Every form asks for the same things. Nothing agrees what to call them."_

The product currently fills nothing, and the page should be honest about that rather than implying
otherwise.

### What I do not want

- A generic SaaS landing page: gradient hero, three feature cards with icons, logo cloud, pricing
  table. None of that applies.
- The current AI-design house styles — cream background with a serif display face and a terracotta
  accent; near-black with one acid-green accent; a fake-broadsheet layout with hairline rules. If
  you land on one of those, it should be because this brief demanded it, not by default.
- A big number with a small label under a gradient as the hero. Too easy.
- Decoration that encodes nothing. Numbered steps only if the content is genuinely a sequence.

### What I want from you

1. First, **a short design plan before any code**: a palette of 4–6 named hex values, the typefaces
   for display / body / machine-text roles, a layout concept described in prose plus a rough ASCII
   wireframe, and the one signature element this page will be remembered by.
2. Then critique your own plan against this brief — name anything that reads like a default rather
   than a choice made for _this_ product, and revise it.
3. Then build it as a **single self-contained HTML file** with realistic mock data (use the real
   numbers above — the 22-field job application and the 14-field messy form), showing all four
   states. I'll port it into the Next.js app afterwards.

Ask me questions if anything here is ambiguous.
