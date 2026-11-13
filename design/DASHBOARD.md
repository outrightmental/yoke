# The Dashboard: the field and the inbox

The Dashboard used to be a header, three bordered panels, a log strip and a status bar: fixed rectangles, with whatever was happening forced into them. An engine burning through a three-hour implementation had the same forty pixels as an idle one; a backlog issue nobody would touch this week had the same pill as the PR waiting on you; and the one thing on the page you could *do* — approve a PR — was a 60-pixel button on a row somewhere in the middle of a list.

It is now two things:

- **The field** — one `<canvas>` the size of the window, on which the state of the whole run is drawn.
- **The inbox** — every interaction the Dashboard offers, as cards, down the right-hand edge of the screen.

The README's [Dashboard](../README.md#dashboard) section says what each shows. This document says how they are built, and why that way.

## The idea: heat rises

`shared/burn-level.ts` answers "how much token burn does this piece of work stand for right now?" with four levels — `burning`, `queued`, `waiting`, `cold` — and the field is built on the answer. A level is a stratum; the strata are stacked hottest first; and the hotter a stratum, the more room each piece of work in it has and the brighter its ink:

| Level | What it is | How it is drawn | In colour |
| --- | --- | --- | --- |
| `burning` | an engine is running an action on it | a *reactor*: the engine's ring, and the work in large type beside it | the work's own hue |
| `queued` | Yoke works it next | a line, with a second line of detail while there is room | gray, banded; a status signal if it has one |
| `waiting` | on someone else first | a line | gray, banded; a status signal if it has one |
| `cold` | nothing is coming | a line of small print | gray, banded; a status signal if it has one |

Nothing has a box of fixed size. An empty stratum takes no room at all, not even a heading. A stratum is never set in more columns than it has work for. And when the window cannot hold everything, the whole field steps down to a denser set of sizes (`DENSITIES` in `field/layout.ts`) before it asks to be scrolled.

## Colour: the rainbow burns, everything below it is gray

Every issue owns a hue for ever (`shared/issue-colors.ts`, #236), and for a while every piece of work wore it at every level, at a saturation that fell with its heat (#281). That said two things with one colour — *which issue* and *how hot* — and it spent the strongest signal on the page, saturated colour, on forty lines at once: a dashboard of six engines and forty pieces of work was a rainbow from top to bottom, and a red error or an orange block was one more colour in it. Since #286 the rainbow says one thing, *this is burning*, and is kept for the one stratum where it is true.

### The rule

- **The burning stratum is drawn in the work's hue.** A reactor, its engine's ring, the comet on it and the glow under it; an engine on the bench that still holds the work its action ended on, until it goes idle (`cylinderColor`); a reactor whose work has gone dark while its engine finishes (#268). An engine keeps the hue for as long as its work is on screen.
- **Every stratum below is hue-free gray.** A line's number, its track and the glyph at its end are `--trim-dim`; its title `--trim-bright`. Heat is said in how bright that ink is, how big the type and how much room a line has — never in colour (`INK` and `ROW_TYPE` in `field/painter.ts`).
- **Below the reactors, saturated colour means a state** — one of the status signals in `styles/tokens.css`, and never an issue's colour (`WorkSignal` in `shared/work-view.ts`).
- **What identifies a piece of work keeps its hue wherever the work is**: the one mark on its line (below), its inbox card's edge, and the tether between them. That is what lets a card be matched to its line, and a line to the reactor it came from.

`WorkView.hue` is the work's colour, whatever its level; `WorkView.color` is the colour it is drawn in — its hue while an engine is on it, `--trim-dim` otherwise. Each pane reads the one it means, so the field, the inbox and the markup cannot disagree.

### Telling neighbours apart: two grays

The hue was doing a job besides saying which issue: it told one line from the next. With forty gray lines in four columns, up to 760 pixels wide and with their status set against the right-hand end, the eye loses its line between the title and the status. So the lines below the reactors are *banded*: counted down each column, every other line lies on a band, the ground lifted by 3.5% of `--trim-bright`. Two values of gray — the ground and the band — alternate down every stratum below the reactors, the same in each, so a line and its neighbours are always on two different grays, and a two-line row's lines read as one.

Decisions about the bands, and why:

- **Behind the line, not in its ink.** Alternating the ink of the lines between two grays would tell neighbours apart too, but ink brightness already says heat, and one line in two would read as cooler than its neighbour. A band changes nothing a line says.
- **They belong to the stratum, not to the lines.** The bands are laid out with the stratum (`HeaderNode.bands` in `field/layout.ts`) and drawn where its heading is. When a piece of work leaves, the lines under it slide up across bands that stay put, like ruled paper; bands that were drawn per line would flip from line to line on every change, and the whole stratum below would flicker.
- **As faint as will still be seen.** 1.06:1 against the ground, about three just-noticeable steps of lightness (L\* 4.0 to 6.9). Strong enough to read across a room; weak enough that no word on a band drops below its floor — the darkest signal, red, keeps 4.7:1 on one. It reaches 8 pixels past its line, as far as the wash behind a line under the pointer, so the two line up.
- **Not in the burning stratum.** Reactors are told apart by their rings and their hues.

### Which issue: one mark of its hue

Each line below the reactors keeps its issue's hue in exactly one place: the mark its track has reached — the dot on *issue · build · draft · ready · merged* that says how far along it is. The marks behind it, and the line joining them, are gray. It is the same hue as the work's reactor, its inbox card and its tether, so a piece of work can be followed as it cools from a reactor into the strata below, and the ring that spreads from it when its state changes is already drawn in that hue.

A hue can happen to be close to a signal's — an issue's red mark beside an error — so the two are kept apart by place and shape: an issue's mark is always a 5-pixel dot on the track at the left of the line, and a signal is always words and a glyph at its right-hand end.

### What state: the signals

A line has at most one signal, worked out with its status in `workStatus`, so the words always say what the colour means. It colours the status and the glyph at the end of the line, and nothing else; the number, the title and the track stay gray. A signal is drawn at full strength in every stratum — an alarm does not cool — and is never the only way it is said: there is always a glyph's shape and words.

| Signal | Colour | When |
| --- | --- | --- |
| `error` | red, `--color-red` | its last action failed and no engine has taken it up again (`WorkView.failure`, for as long as the inbox lists it); its checks are failing; its approval was refused or failed |
| `blocked` | orange, `--color-orange` | it is blocked by other issues — a hold, like a usage limit or a shutdown, which are orange too |
| `review` | yellow, `--color-yellow` | it waits on a person: ready for review, or parked for an approval Yoke is asking for |
| `approved` | green, `--color-green` | an approval going through: approved, and waiting for or undergoing its merge |
| none | gray | merged; `manual`; out of the queue; checks running; waiting for an engine; implementing; an approval sent and not yet answered; shut down |

Red, orange and yellow were chosen for the three states the field most needs to be seen (#286). Merged and manual are outcomes nobody has to act on here, so they stay neutral. Green is the one signal kept from before: it already meant an approval going through — the Approve button, and the point that travels back along a tether once a person has acted — and an approved PR waiting for its merge is exactly that. Coral is left to the inbox, for a card's problem line. The next state that earns a colour of its own takes blue or turquoise, rather than lending it one of these.

### The grays, and their contrast

Every gray is one of the trim tokens at an alpha over the ground. Each was set to clear a floor against the darkest ground (`--bg-dark`) — WCAG's 4.5:1 for words that identify a line or signal a state, and 3:1 for a neutral status and for marks — and checked on a band as well (`test/field-painter.test.ts`):

| On the ground / on a band | Title | Number | Status (neutral) | Status (in progress) |
| --- | --- | --- | --- | --- |
| queued | 11.9 / 11.3 | 5.7 / 5.4 | 3.9 / 3.8 | 6.9 / 6.7 |
| waiting | 7.5 / 7.2 | 5.3 / 5.0 | 3.4 / 3.3 | 5.8 / 5.7 |
| cold | 4.8 / 4.8 | 4.8 / 4.6 | 3.1 / 3.1 | 5.2 / 5.2 |

| Signal | red | orange | yellow | green |
| --- | --- | --- | --- | --- |
| on the ground / on a band | 4.9 / 4.7 | 6.6 / 6.2 | 12.8 / 12.0 | 14.4 / 13.6 |

A glyph with no signal is 5.7:1, and the marks behind a track's reached mark 3.4:1. To meet those floors a cold title went from 0.46 to 0.54 of `--trim-bright` (it was 3.8:1), and a neutral status from 0.66 and 0.5 to 0.7 and 0.66 of `--trim-dim` in the waiting and cold strata (the cold one was 2.3:1). The gray number is also steadier than the hue it replaces: a line's number used to be anywhere from 2.8:1 (a blue issue) to 18:1 (a yellow one), depending only on its issue number.

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

`workViews` (`shared/work-view.ts`) works out everything the Dashboard says about a piece of work, once: its level, its hue and the colour it is drawn in at that level, how far along the lifecycle it is, the one line saying what it is waiting on and the signal it is coloured for, the mark at the end of its line, the engine on it, the action that last failed on it, and what its approval shows. The field, the inbox and the screen-reader markup all read that one description, so they cannot disagree about a piece of work.

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

A canvas cannot say `var(--trim)`. `field/palette.ts` reads the custom properties of `styles/tokens.css` once and hands the painter numbers, so the rule from #280 holds for what is painted as well as for what is styled: trim is hue-free gray, the only saturated colours that are not a piece of work's own are the named status signals, and no source file under `src/dashboard` brings a colour of its own. `test/dashboard-trim.test.ts` checks both the sources and what the painter actually fills with — including that below the burning stratum a work's hue reaches the canvas as one dot and nothing else does but a signal.

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

A card about a piece of work is edged in the work's own hue, at whatever level the work is, and joined to it by a line in the same hue. The line leaves along the rule under the work's own line, runs out to a gutter between the field and the inbox, turns up or down the gutter to the height of the card, and goes in — so it never crosses text. Each tether takes its own lane in the gutter. A point travels along it: towards the card while the work waits on a person, and back, in green, once that person has acted.

The inbox is DOM and the field is canvas, so the inbox reports where its cards are (`inbox-anchors`) and the field draws to those points.

## Accessibility

A canvas is opaque to a screen reader and to the keyboard. `<yoke-field>` therefore also renders everything it draws as ordinary markup, out of sight but not hidden: the engines as a list, each stratum under a heading, and every piece of work as a link to GitHub. Focusing one of those links draws a focus ring around the same thing on the canvas and scrolls it into view. The inbox and the activity drawer are ordinary DOM.

## Working on it

```bash
npm run demo:dashboard
```

starts the real Dashboard server and feeds it the events a real run emits, from a small simulation of the loop over a made-up backlog (`tools/dashboard-demo.ts`). An Approve press is answered the way Yoke answers one. `--scene=` shows it busy, quiet, held on a usage limit, with one project, crowded past what fits, or in Project SDLC; `--shutdown-after=` shows a graceful shutdown; `--fail=` makes runs fail.

`npm run build` type-checks the browser code as well as the server's (`npm run typecheck:dashboard`): the root `tsconfig.json` leaves `src/dashboard` out of its build, so until now only the files a test happened to import were ever checked.
