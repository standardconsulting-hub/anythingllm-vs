# vs-theme — Varney Standard brand overrides for the AnythingLLM frontend

This directory contains the Varney Standard ("The Declaration") brand
skin for the AnythingLLM frontend.

## Why it exists

AnythingLLM is an upstream MIT-licensed project that VS forks for the
firm's Layer One AI surface. Every direct edit to an upstream-owned
file is a future merge-conflict point. This directory contains the
**only** files VS adds to the frontend; every other change is either
in `index.html` (which we own), `tailwind.config.js` (token-layer
config), `LogoContext.jsx` (a single-line import swap), or a small
set of high-visibility user-facing strings.

The principle: brand overrides as a layer, not as scattered edits.

## What lives here

```
vs-mark.svg            — VS mark for dark backgrounds (white letters, teal Point)
vs-mark-light.svg      — VS mark for light backgrounds (dark letters, teal Point)
vs-login-logo.svg      — Login-screen variant with tagline
vs-favicon.svg         — Browser favicon (rounded VS on black with teal Point)
vs-overrides.css       — :root CSS variable overrides + bullet-replacement + focus styles
```

## How it wires in

1. `src/index.css` adds `@import "./vs-theme/vs-overrides.css";` at the
   top, so the override variables run before AnythingLLM's defaults
   take effect.
2. `src/LogoContext.jsx` imports the four VS marks instead of the
   AnythingLLM PNGs. Same fallback chain; same fetchLogo override.
3. `tailwind.config.js` adds Outfit + Space Mono font families and
   sets the `teal` shorthand to Signal Teal `#14B8A6`.
4. `index.html` loads Outfit, Plus Jakarta Sans, and Space Mono from
   Google Fonts; sets the title and meta tags to VS; references
   `vs-favicon.svg` for the favicon.

## Brand reference

The source of truth is the user's varney-standard-brand skill:
`~/.claude/skills/varney-standard-brand/SKILL.md`. Anything in this
directory that contradicts the skill should be amended to match.

## What does not live here

- Functional UI changes (cross-workspace toggle, retrieval, audit) —
  those are in their respective AnythingLLM source files.
- Backend / API customisation.
- App name string replacements (those are in `index.html`, `i18n`
  locale files, and a small list of component edits — kept minimal).
- The brand voice for AI outputs — that lives in the system prompt
  at `runtime/system-prompts/default-v1.0.md` in the spec repo and
  in `runtime/firm-reference/01-house-style.md`.

## When this should be reviewed

- Before the demo: confirm the marks render correctly, the palette
  reads as VS, and no Mintplex strings remain in the user-facing path.
- On any upstream merge from `mintplex-labs/anything-llm`: confirm
  no new theme variables have been introduced that the override file
  needs to set.
- On any change to the brand guidelines: amend `vs-overrides.css`
  and the SVG marks accordingly.
