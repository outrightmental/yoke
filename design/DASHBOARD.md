# The Dashboard: the field and the inbox

The Dashboard used to be a header, three bordered panels, a log strip and a status bar: fixed rectangles, with whatever was happening forced into them. An engine burning through a three-hour implementation had the same forty pixels as an idle one; a backlog issue nobody would touch this week had the same pill as the PR waiting on you; and the one thing on the page you could *do* — approve a PR — was a 60-pixel button on a row somewhere in the middle of a list.

It is now two things:

- **The field** — one `<canvas>` the size of the window, on which the state of the whole run is drawn.
- **The inbox** — every interaction the Dashboard offers, as cards, down the right-hand edge of the screen.

The README's [Dashboard](../README.md#dashboard) section says what each shows. This document says how they are built, and why that way.

## The idea: heat rises

`shared/burn-level.ts` already answered "how much token burn does this piece of work stand for right now?" with four levels — `burning`, `queued`, `waiting`, `cold` — and used the answer for one thing: the saturation of a colour. The field uses it for everything else as well. A level is a stratum; the strata are stacked hottest first; and the hotter a stratum, the more room each piece of work in it has:

| Level | What it is | How it is drawn |
| --- | --- | --- |
| `burning` | an engine is running an action on it | a *reactor*: the engine's ring, and the work in large type beside it |
| `queued` | Yoke works it next | a line, with a second line of detail while there is room |
| `waiting` | on someone else first | a line |
| `cold` | nothing is coming | a line of small print |

Nothing has a box of fixed size. An empty stratum takes no room at all, not even a heading. A stratum is never set in more columns than it has work for. And when the window cannot hold everything, the whole field steps down to a denser set of sizes (`DENSITIES` in `field/layout.ts`) before it asks to be scrolled.

## How a frame is made

```text
DashboardState ──► workViews / engineViews / vitals      shared/   what each thing is and where it stands
       │                    │
       │                    ├──► buildInbox ──► cards    shared/inbox.ts
       │                    ▼
       └──────────► fieldModel                           field/model.ts     what goes in which stratum
                            ▼
                      layoutField                        field/layout.ts    where: boxes, and nothing else
                            ▼
                       Animator                          field/animator.ts  where everything is on the way there
                            ▼
                        Painter                          field/painter.ts   what it looks like
```

Every step above the painter is a plain function of the store's state, the clock and the size of the window. None of them touches a canvas, the DOM, or a font, which is why all of them are tested in Node: `test/work-view.test.ts`, `test/inbox.test.ts`, `test/field-layout.test.ts`. The painter is tested too, against a canvas that draws nothing and remembers what it was asked to draw (`fakeCanvas` in `test/dashboard-helpers.ts`), so "the status of a blocked issue is drawn in coral" is an assertion, not a screenshot.

### One description of each piece of work

`workViews` (`shared/work-view.ts`) works out everything the Dashboard says about a piece of work, once: its level, its colour at that level, how far along the lifecycle it is, the one line saying what it is waiting on, the mark at the end of its line, the engine on it, and what its approval shows. The field, the inbox and the screen-reader markup all read that one description, so they cannot disagree about a piece of work.

### Layout is geometry

`layoutField` returns rectangles: a box for every engine's ring, every reactor's words, every line of work, every heading. It measures no text. That keeps it fast enough to run on every event and every tick of the clock without thinking about it — it is one pass over a few dozen boxes — and it means a test can assert that nothing on the field overlaps anything else at five window sizes and three workloads.

Two rules in it are about things staying put, because a dashboard is watched out of the corner of an eye and anything that moves had better mean something:

- The reactor grid's columns are set by the size of the pool, not by how many engines happen to be burning. A reactor keeps its width — and its title its line breaks — as the engines around it start and stop.
- A stratum is filled down each column in turn. When a piece of work leaves, the ones under it close up by a line, and nothing else moves.

### Identity is what makes motion mean something

A node keeps its id for as long as the thing it stands for exists: `work:<key>` for a piece of work, `engine:<n>` for an engine's ring. The animator moves a node from where the last layout had it to where the new one does, on a critically damped spring (`field/spring.ts`), so a change of state reads as one thing going somewhere: a PR whose checks pass slides up a stratum; an engine's ring swings out from the bench to the work it has just taken, growing as it goes, and back when it is done.

The springs are stepped with the closed-form solution rather than by integrating a force, so they land in the same place at any frame rate and cannot blow up after a tab has been in the background. A node that changes *shape* — a line becoming a reactor — is cross-faded rather than tweened, and a node far from where it belongs is drawn faint and firms up as it arrives, so two things crossing on their way are never two lines of text on top of one another.

### Painting, and not painting

Almost nothing on the field moves almost all of the time, so the painter has two passes:

- `paintStatic` draws the whole picture, onto an offscreen layer, and runs only when the picture changes: an event arrived, something is on a spring, the clocks ticked over.
- `paintDynamic` draws the few marks that never stop — the comets on burning rings, the orbit on a line whose checks are running, the point travelling along a tether — straight onto the visible canvas, and returns the small boxes it drew in. The next frame puts those boxes back from the static layer before drawing them again.

So an open Dashboard with six engines burning repaints six rings and a few glyphs, thirty times a second, and not one letter. With no engine burning it asks for no frames at all. When the tab is hidden it stops; when the person has asked their system for reduced motion nothing loops and nothing glides.

Filling the window is the dearest thing a canvas does — far dearer than all the text together. Profiling the first version, at 3024×1720 device pixels with software rendering, a full repaint took 82 ms, of which 77 were the ground and its glow. So:

- The ground (its fill, the lift toward the top, a little noise so the gradient does not band) is painted once onto a layer of its own and copied from there until the window changes size.
- The glow under a burning ring is a 96-pixel sprite per colour, stretched: a glow has no detail to lose, and stretching a small picture is how it gets its softness for nothing.

That brought the same full repaint to about 11 ms, and a frame of only moving marks to about 0.3 ms.

The canvas is drawn at no more than two device pixels per CSS pixel, and a text measurement is taken once and remembered (`field/text.ts`) until a font loads.

### Colour comes from the tokens

A canvas cannot say `var(--trim)`. `field/palette.ts` reads the custom properties of `styles/tokens.css` once and hands the painter numbers, so the rule from #280 holds for what is painted as well as for what is styled: trim is hue-free gray, the only saturated colours that are not a piece of work's own are the named status signals, and no source file under `src/dashboard` brings a colour of its own. `test/dashboard-trim.test.ts` checks both the sources and what the painter actually fills with.

## The inbox

### Why down the right-hand edge

Someone using a touch screen right-handed has their hand at the right-hand edge already, and reaching for anything else puts their arm across the picture. So everything that can be pressed is there, top to bottom, and the field to its left is for reading. Every target is at least 44 pixels tall and the one button a card exists for is 56; nothing is revealed by hovering, because a finger cannot hover. Tapping something on the field does not act on it — it opens a card at the foot of the inbox that says the rest.

With nothing in it the inbox folds to a strip and gives its room to the field (`shared/rail.ts`).

### Federated: one list, many sources

`buildInbox` (`shared/inbox.ts`) is a list of sources, each a function from the Dashboard's state to cards:

| Source | A card for | Its button |
| --- | --- | --- |
| `keep-awake` | a keep-awake loop the browser refused to autoplay | starts it |
| `approval` | a PR parked by the `review` label, and every approval under way | Approve |
| `review` | a PR Yoke has asked a person to review on GitHub (Project SDLC) | opens it |
| `failure` | an action that failed and has not been taken up again | none; it can be dismissed |
| `manual` | a PR labelled `manual` | opens it |

Every card has the same shape (`InboxCard`), and `<yoke-inbox>` only draws cards. **To add an interaction, write one more function that returns cards and add it to `buildInbox`**; nothing that draws the inbox needs to know of it. If its button does something new, add a variant to `InboxAction` and one `case` to the element.

Two of the sources needed something the Dashboard did not have:

- **`review`** needs to know a PR is parked for a person on GitHub, which the browser cannot work out from a lifecycle pair. The server now says so: `awaitsHumanReview` in `src/orchestrator.ts` mirrors the planner's parking rule — the way `reviewApprovalState` does for the `review` label — and `broadcastLifecycleUpdate` sets `awaitingReview` on the pair. A test pins the two against each other: whatever the planner would act on is never said to be waiting on a person.
- **`failure`** needs the failure to outlive the event that reported it. An engine reports itself idle in the same tick as its action fails, so the cylinder's `error` status never survived long enough to be seen. The store now keeps the latest failure per piece of work (`DashboardState.failures`) until an engine starts on that work again, the work leaves the lifecycle, or it is older than Yoke's longest retry backoff.

### The approval is the pill's, moved

`shared/pill-approval.ts` — `approvalView`, the press ledger in the store, the request and its answers over the socket — is unchanged. An approval card shows exactly the button and the line the pill showed, so everything #274, #276 and #278 established still holds: one press approves, it reads Queued at once, it follows Yoke's reports and never a timer, and it never falls back to Approve as if it had not been pressed.

### Never under a finger

One press merges a pull request, so the list must never be what chose which.

- The order is stable. Cards are grouped by source and, within a source, listed in the order they arrived (`InboxLedger`), so a card never moves because of how it *changes*, and a new one lands below the others of its kind.
- Cards are keyed by what they stand for, so an element stays the card it was drawn as.
- For 600 ms after a card has arrived or moved — the card above it left and it slid up — its button takes no press (`cardsToShield`).

### Tethers

A card about a piece of work is joined to it by a line. The line leaves along the rule under the work's own line, runs out to a gutter between the field and the inbox, turns up or down the gutter to the height of the card, and goes in — so it never crosses text. Each tether takes its own lane in the gutter. A point travels along it: towards the card while the work waits on a person, and back, in green, once that person has acted.

The inbox is DOM and the field is canvas, so the inbox reports where its cards are (`inbox-anchors`) and the field draws to those points.

## Accessibility

A canvas is opaque to a screen reader and to the keyboard. `<yoke-field>` therefore also renders everything it draws as ordinary markup, out of sight but not hidden: the engines as a list, each stratum under a heading, and every piece of work as a link to GitHub. Focusing one of those links draws a focus ring around the same thing on the canvas and scrolls it into view. The inbox and the activity drawer are ordinary DOM.

## Working on it

```bash
npm run demo:dashboard
```

starts the real Dashboard server and feeds it the events a real run emits, from a small simulation of the loop over a made-up backlog (`tools/dashboard-demo.ts`). An Approve press is answered the way Yoke answers one. `--scene=` shows it busy, quiet, held on a usage limit, with one project, crowded past what fits, or in Project SDLC; `--shutdown-after=` shows a graceful shutdown; `--fail=` makes runs fail.

`npm run build` type-checks the browser code as well as the server's (`npm run typecheck:dashboard`): the root `tsconfig.json` leaves `src/dashboard` out of its build, so until now only the files a test happened to import were ever checked.
