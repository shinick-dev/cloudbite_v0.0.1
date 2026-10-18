---
name: Cloudbite
description: Expert sandboxes for one shared project — blue-white operator console (v0.0.1).
colors:
  navy: "#0b1d3f"
  navy-2: "#13294f"
  navy-ink: "#e8efff"
  blue: "#1f6feb"
  blue-hover: "#185bc4"
  blue-ink: "#ffffff"
  blue-soft: "#e7f0fe"
  blue-softer: "#f2f7ff"
  canvas: "#eef4fc"
  surface: "#ffffff"
  sunk: "#f5f8fd"
  nav-bg: "#f8fbff"
  ink: "#0f1f3d"
  muted: "#5b6b86"
  faint: "#64748b"
  line: "#d9e5f5"
  line-strong: "#bdd0ea"
  stream: "#0a1530"
  stream-line: "#1c2c52"
  stream-ink: "#d5e1f7"
  stream-muted: "#7f93ba"
  support: "#147a50"
  conditional: "#9c6508"
  concern: "#b93547"
  abstain: "#64748b"
  support-soft: "#e3f6ee"
  conditional-soft: "#fdf2dc"
  concern-soft: "#fde8eb"
  abstain-soft: "#eef1f6"
  demo-bg: "#fff8e8"
  demo-ink: "#6b4a07"
typography:
  wordmark:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "30px"
    fontWeight: 750
    lineHeight: 1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 700
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.06em"
  mono:
    fontFamily: "ui-monospace, Cascadia Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "12.5px"
    lineHeight: 1.6
rounded:
  sm: "10px"
  md: "12px"
  lg: "14px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "14px"
  lg: "18px"
  xl: "24px"
components:
  header:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.navy-ink}"
    height: "70px"
    padding: "0 24px"
  nav-item:
    backgroundColor: "{colors.nav-bg}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  nav-item-selected:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.blue-ink}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.blue-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
    textColor: "{colors.blue-ink}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  button-ghost:
    textColor: "{colors.blue}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  button-tool:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px 18px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  execution-stream:
    backgroundColor: "{colors.stream}"
    textColor: "{colors.stream-ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    height: "394px"
  demo-banner:
    backgroundColor: "{colors.demo-bg}"
    textColor: "{colors.demo-ink}"
    rounded: "{rounded.sm}"
    padding: "9px 14px"
  chip-support:
    backgroundColor: "{colors.support-soft}"
    textColor: "{colors.support}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
---

# Design System: Cloudbite

Scope: the Cloudbite operator console served at `/cloudbite` — `client/cloudbite-console.css` and the markup built in `client/cloudbite-console.ts` (pinned into `src/cloudbite-page.ts` by `tools/build-cloudbite-console.mjs`). The unchanged legacy lab (`/lab`) and the classroom prototype (`docs/prototypes/classroom/DESIGN.md`) are out of scope. The offline pitch preview has its own scoped record in `demo/DESIGN.md`.

## Overview

**Creative North Star: "Expert workspaces on a blue-white console"** (a descriptive label for the user-pinned layout, not a separately approved metaphor).

The user pinned the frame: a full-width navy header (70px), a light 224px navigation sidebar, a central expert workspace, a right progress/decision rail, white panels with pale-blue borders, and a dark read-only execution stream about 394px tall. The layout is adapted from an AI-coding-lab arrangement to Cloudbite's expert-sandbox product; it does not reuse classroom terminology. UI copy is English. Primary viewport is 1536×1024.

The console is dense and operational: 13–14px body text, small uppercase eyebrows, mono only for the stream, file paths and timestamps. Colour carries state, not decoration. Honesty is part of the visual system: the run mode is always visible, confidence is labelled as self-assessment, and counts derive from verified run data.

**Key Characteristics:**
- Navy frame, blue-white work area, one bright blue accent for actions and selection.
- Flat panels separated by 1px pale-blue borders; no drop shadows on containers.
- A near-black navy stream as the single dark surface inside the workspace.
- Four opinion directions (support / conditional / concern / abstain) with fixed colours.
- System font stack only; no web fonts, no CDN, icons as inline SVG data-URI masks.

## Colors

A cool blue-white palette framed in navy, with one saturated blue and four semantic direction colours.

### Primary
- **Signal Blue** (`blue`): primary buttons, selected nav item, selected tab underline, focus ring, eyebrows, running status dots and progress segments, histogram bars. Hover deepens to `blue-hover`.
- **Console Navy** (`navy`, `navy-2`): header background and the profile capsule. Text on navy uses `navy-ink` and white.

### Secondary
- **Opinion directions**: `support` (green), `conditional` (amber), `concern` (red), `abstain` (slate), each with a `*-soft` tint for chips, pills and notices. They appear only where an opinion, run status or error is shown.

### Neutral
- **Canvas** (`canvas`): page background. **Surface** (`surface`): panels, cards, inputs. **Sunk** (`sunk`): tool buttons, file viewer, opinion block. **Nav background** (`nav-bg`): sidebar.
- **Ink / Muted / Faint**: primary text, secondary text, timestamps and counters.
- **Line / Line strong**: panel borders and dividers; input and secondary-button borders.
- **Stream set** (`stream`, `stream-line`, `stream-ink`, `stream-muted`): the execution stream only.
- **Demo amber** (`demo-bg`, `demo-ink`): the browser-demo banner and badge (`#fff3d6` / `#6e4a00`).

### Named Rules
**The Mode-Is-Always-Visible Rule.** Every screen shows the run mode twice: a header badge (amber "Browser demo" or green "Live") and a banner under the header stating what is and isn't real ("Browser demo — simulated activity and files; no Daytona or Nosana calls.").

**The Blue-Means-Selected Rule.** A solid `blue` fill marks the current nav item (`aria-current="page"`); tinted `blue-softer` with a `blue` border marks a selected expert card, catalogue option or file.

## Typography

**Body Font:** system UI stack (`system-ui, -apple-system, "Segoe UI", Roboto, …`). **Mono Font:** `ui-monospace, "Cascadia Mono", …, Consolas`.

**Character:** neutral system sans for density and zero font loading; mono marks machine output.

### Hierarchy
- **Display** (750, 30px, line-height 1): the progress count ("4 / 4").
- **Wordmark / Headline** (750 / 700, 19px): "Cloudbite" in the header, current project title.
- **Title** (700, 17px): panel headings (`h2`). Page heads in Guide/Help/Settings use 20px.
- **Body** (400, 14px/1.5; 13–13.5px in panels): copy. Project paragraphs cap at 75ch.
- **Label** (700, 11px, 0.06em, uppercase): "CURRENT PROJECT" eyebrow (blue) and "WORKSPACE" nav label (faint).
- **Mono** (12.5px/1.6): stream rows, file paths (12px), timestamps.

## Layout

- **Shell:** header 70px; below it a two-column grid `224px | 1fr` (nav | main). Main padding 18px 22px 28px, vertical gap 14px.
- **Home:** `1fr | 340px` grid (workspace column | right rail), gap 16px. Right rail stacks Project progress → What to do now → Synthesis & confidence.
- **Workspace panel:** head with title + tool buttons, a horizontally scrolling roster of expert cards (150–220px), the 394px stream, then an inspector with Files / Activity / Work order / Persona tabs and a `220px | 1fr` file list + viewer.
- **Breakpoints:** ≤1280px the right rail drops below the workspace as an auto-fit grid (min 280px). ≤860px header shrinks to 60px, subtitle and profile text hide, nav becomes a horizontal row of four under the header, forms and artifact view go single-column, stream rows collapse to time + who with the message on its own line, stream height 340px. ≤480px the version tag hides and panel padding drops to 14px. No horizontal page overflow (`body { overflow-x: hidden }`; grids use `minmax(0, 1fr)`).

## Elevation & Depth

Flat by default. Depth is tonal: navy header, pale canvas, white panels with 1px `line` borders, `sunk` insets, and the dark stream. The only shadows are functional: an inset 1px blue ring on the focused expert card, an inset ring on the active progress step, and a 1px soft shadow on the pressed segmented control.

**The Border-Not-Shadow Rule.** Panels separate by border and tone; never add ambient drop shadows to cards.

## Shapes

Gently rounded rectangles: 14px for panels and the tip card, 12px for the stream, 10px for buttons, inputs, nav items, cards and notices, 999px for badges, pills and chips, circles for status dots, step marks and the avatar. Opinion blocks use a 3px left rule in the direction colour with the left corners squared.

## Components

### Buttons
- **Primary** (Run / Run again): solid blue, white text, 8px 16px, 16px icon. Hover `blue-hover`.
- **Secondary** (Stop): white with `line-strong` border; hover turns border and text blue.
- **Ghost** (Edit project, Export report, Export JSON, Clear token): transparent blue text; hover `blue-softer`.
- **Tool** (Full screen, Clear view, Restore history): `sunk` fill, `line` border, 12.5px; hover blue border/text.
- **Disabled:** opacity 0.45, `not-allowed`. Start is disabled while a run is in flight.

### Navigation
Sidebar buttons Home / Guide / Help / Settings with 18px mask icons. Selected = solid bright blue with white text; hover = `blue-softer`. Footer shows capacity ("Up to 5 experts per project · 3 run at once") and links to "Try a sandbox" (`/cloudbite/access`) and "Legacy lab".

### Execution stream (signature)
Dark navy panel, bar with pulse icon, "Execution stream" title, a "read-only" capsule and a mono state line (`simulated · completed · 0 active · 28 events`). Rows are a `70px 150px 64px 1fr` mono grid (time, expert, kind, message); kind colours: tool cyan, thought violet, artifact green, error pink. It is an `ol role="log"`, focusable for scrolling, with no input or terminal prompt. **Clear view** only hides current rows from this window; **Restore history** brings them back; project history and files are never changed. **Full screen** turns the workspace panel into a fixed overlay (stream fills ≥60vh); Escape or "Exit full screen" returns and refocuses the button.

### Cards, chips and status
- **Panel:** white, `line` border, 14px radius, 16px 18px padding.
- **Expert card:** name, status dot (blue provisioning/running, green completed, red failed, slate cancelled) and a direction chip with self-assessed confidence.
- **Pills/chips:** soft tint + dark text per status/direction; `invalid` uses the concern tint.

### Inputs / Fields
1px `line-strong` border, 10px radius, white fill, 8px 10px padding; character counters in 11px faint. Expert catalogue options are bordered tiles that turn `blue-softer` with a blue border when checked (`accent-color: blue`). The admin token field is a password input kept in memory only; no API keys are accepted.

### Synthesis & confidence
Counts "N / M valid opinions" with failed, queued/working, cancelled and invalid listed separately and the note "only completed, valid opinions are counted". A distribution bar and legend use the direction colours; the histogram (0–19 … 80–100) uses blue bars and states "each role's self-assessment, not calibrated accuracy".

### Keyboard and focus
Global `:focus-visible` is a 2px blue outline with 2px offset (stream log uses a -2px inset offset). Inspector tabs follow the tab pattern: ArrowLeft/ArrowRight wrap, Home/End jump. Colour transitions (0.15s) apply only under `prefers-reduced-motion: no-preference`.

## Do's and Don'ts

### Do:
- **Do** keep the pinned frame: 70px navy header, 224px light sidebar, central workspace, right progress/decision rail, 394px dark stream.
- **Do** label demo output as simulated in the header badge, the banner, the stream state and exported files.
- **Do** describe confidence as self-assessment and aggregate only completed, valid opinions; show failed/pending/cancelled counts beside it.
- **Do** use the system font stack and inline SVG mask icons; no external fonts or CDN assets (same-origin CSP).

### Don't:
- **Don't** add a command input or terminal prompt to the execution stream; it is read-only.
- **Don't** reintroduce the earlier warm off-white / forest-green palette.
- **Don't** imply calibrated accuracy, live provider execution in demo mode, or capacity beyond what the console states.
- **Don't** add drop shadows to panels or a second accent colour for actions.
