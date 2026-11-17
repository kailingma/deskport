---
name: deskport
description: A plain, corporate control surface for one person's desktop and terminal, styled like a page of the Cloudflare dashboard.
colors:
  primary: "oklch(0.55 0.19 260)"
  primary-ring: "oklch(0.45 0.2 260)"
  primary-dark: "oklch(0.66 0.163 260)"
  primary-fill-dark: "oklch(0.55 0.2 260)"
  on-primary: "oklch(1 0 0)"
  ground: "oklch(0.975 0 0)"
  surface: "oklch(1 0 0)"
  surface-raised: "oklch(0.955 0 0)"
  surface-pressed: "oklch(0.92 0 0)"
  hairline: "oklch(0.9 0 0)"
  hairline-strong: "oklch(0.82 0 0)"
  text: "oklch(0.21 0 0)"
  text-secondary: "oklch(0.45 0 0)"
  ground-dark: "oklch(0.13 0 0)"
  surface-dark: "oklch(0.17 0 0)"
  surface-raised-dark: "oklch(0.21 0 0)"
  surface-pressed-dark: "oklch(0.26 0 0)"
  hairline-dark: "oklch(0.27 0 0)"
  hairline-strong-dark: "oklch(0.34 0 0)"
  text-dark: "oklch(0.97 0 0)"
  text-secondary-dark: "oklch(0.72 0 0)"
  stage: "oklch(0.16 0 0)"
  stage-dark: "oklch(0.09 0 0)"
  state-ok: "oklch(0.6 0.15 150)"
  state-warn: "oklch(0.7 0.15 75)"
  state-bad: "oklch(0.58 0.21 27)"
typography:
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  brand:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  tab-label:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  sheet: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost-icon:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    size: "32px"
  button-ghost-icon-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
  button-text:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  segmented:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.md}"
    padding: "3px"
  segmented-item-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: "28px"
  status-badge:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 9px"
  top-bar:
    backgroundColor: "{colors.surface}"
    height: "52px"
  floating-toolbar:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    height: "48px"
  key:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "36px"
  key-modifier-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  tab-bar:
    backgroundColor: "{colors.surface}"
    height: "56px"
  sheet:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.sheet}"
  dialog-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "20px"
  select:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "34px"
  switch:
    backgroundColor: "{colors.surface-pressed}"
    rounded: "{rounded.pill}"
    width: "40px"
    height: "24px"
  switch-on:
    backgroundColor: "{colors.primary}"
---

# Design System: deskport

## Overview

**Creative North Star: "A Page of the Dashboard"**

deskport is a single-purpose app that should look like it belongs next to the Cloudflare dashboard, then Vercel and Tailscale: Inter, untinted greys, hairline borders, one blue, and nothing that is there only to look designed. The user steered to this explicitly and rejected decorative directions. The remote screen and the terminal are the content; every piece of chrome exists to name the machine, show whether it is connected, switch views, or reach a few desktop keys, and then stay out of the way.

Density is low-to-moderate and calm. Controls are 32px on desktop and grow to 40px on coarse pointers; the thumb is the design constraint on a phone and the keyboard on a laptop. Depth is a single hairline-plus-soft-shadow vocabulary. There is no illustration, no gradient in the UI, no decorative motion. The one expressive object is the app icon, which lives outside the interface.

**Key Characteristics:**
- Inter Variable throughout the chrome; the terminal has its own selectable monospace.
- Neutral oklch greys with zero chroma for ground, surface and borders.
- One blue (hue 260) for primary action, selection and focus. Green, amber and red appear only as connection state.
- Light and dark follow the system; the user can override with Settings, stored as `html[data-theme]`.
- Radii: 6px small, 8px controls, 12px floating surfaces, 16px for bottom sheets.
- The remote screen sits on a near-black stage in both themes.

## Colors

A neutral grey ladder carries almost everything; blue is the only chromatic voice, and state colours are held in reserve for connection status.

### Primary
- **Dashboard Blue** (oklch(0.55 0.19 260) light, oklch(0.66 0.163 260) dark): selected tab-bar item, active modifier key, switch-on track, range accent, focus ring, text selection tint (at 12% / 18% alpha), the touch ring on the remote screen, and the small mark in the top bar.
- **Blue Fill** (`--primary-fill`; oklch(0.55 0.19 260) light, oklch(0.55 0.2 260) dark): the fill of filled blue controls with white text (primary button, toast action, active modifier key, switch-on track). Dark mode keeps it darker than Dashboard Blue so those controls do not glare.
- **Blue Ring** (oklch(0.45 0.2 260) light, oklch(0.44 0.19 260) dark): the 1px outline that edges filled blue controls so they hold their shape.

### Neutral
- **Ground** (oklch(0.975 0 0) light, oklch(0.13 0 0) dark): the page background behind everything.
- **Surface** (oklch(1 0 0) light, oklch(0.17 0 0) dark): top bar, floating toolbar, tab bar, dialogs, sheets, inputs, selected segment.
- **Surface Raised** (oklch(0.955 0 0) light, oklch(0.21 0 0) dark): segmented track, status badge, key row background, hover fill, cancel button.
- **Surface Pressed** (oklch(0.92 0 0) light, oklch(0.26 0 0) dark): active/pressed fill, switch-off track.
- **Hairline** (oklch(0.9 0 0) light, oklch(0.27 0 0) dark): every 1px border and divider. **Hairline Strong** (oklch(0.82 0 0) / oklch(0.34 0 0)): sheet grabber, toolbar handle bar, select hover border.
- **Ink** (oklch(0.21 0 0) / oklch(0.97 0 0)) for text; **Ink Secondary** (oklch(0.45 0 0) / oklch(0.72 0 0)) for icons, labels, help text and idle controls.
- **Stage** (oklch(0.16 0 0) light, oklch(0.09 0 0) dark): the backdrop of the remote screen, framed by a 1px white-at-6% outline.

### State (connection only)
- **OK** green (oklch(0.6 0.15 150) / oklch(0.74 0.16 150)), **Busy** amber (oklch(0.7 0.15 75) / oklch(0.82 0.14 80), pulses), **Bad** red (oklch(0.58 0.21 27) / oklch(0.7 0.18 25), also colours the badge text). Idle uses Ink Secondary.

### Terminal colour schemes
Six schemes in `web/js/themes.js`, chosen in Settings: deskport dark (default, #0f1012 ground, cursor #6b9cff), deskport light (#fbfbfb, cursor #2463eb), Solarized dark and light, Nord, Gruvbox dark. The deskport pair is tuned to the UI blue; the others are the established community palettes and are not part of the interface palette.

### Named Rules
**The One Blue Rule.** Blue marks the thing you can act on or that is selected. It is never decoration, and no second hue is introduced for emphasis.
**The State-Only Rule.** Green, amber and red mean connection state and nothing else. They do not colour buttons, headings or categories.
**The Untinted Grey Rule.** Greys have zero chroma. Warmth or tint would pull the system away from the dashboard reference.

## Typography

**Display Font:** none; the app has no display tier.
**Body Font:** Inter Variable (served from `/vendor/inter.woff2`, with ui-sans-serif, system-ui, -apple-system, Segoe UI fallbacks), with `cv11` and `ss01` features on.
**Terminal Fonts:** a user choice of system monospace, JetBrains Mono Variable, or IBM Plex Mono (all shipped from `/vendor`); size 9 to 22px.

**Character:** Plain, neutral, product-grade. Hierarchy comes from weight (400, 500, 600) and a narrow size range, not from scale contrast.

### Hierarchy
- **Brand / Title** (600, 15 to 16px, -0.01em): the "deskport" wordmark, dialog and Settings titles.
- **Body** (400, 14px, 1.45): default text, field labels at 500.
- **Label** (500, 13px): segmented items, text buttons, toast, group headings (600, secondary ink).
- **Caption** (500 at 12px for the badge; 400 at 12 to 13px for help and notes): secondary information.
- **Tab label** (500, 11px): the bottom tab bar only.
- **Sheet item** (400, 15px, 48px rows): phone action sheet.

### Named Rules
**The Weight-Not-Size Rule.** Distinguish levels with weight and ink colour first; the sizes stay within 11 to 16px.

## Layout

A single full-viewport column: top bar, then the view fills the rest. The bar is a three-column grid (mark, wordmark, host and status left; Screen/Terminal segmented control centred; tools right) at 52px high with 16px side padding. The side columns shrink before they reach the centre; under 1000px the wordmark and the segment labels go, under 800px the host name. Confirmations use the dialog card (title, body, Cancel and the primary action, right-aligned) over a 55% black backdrop, the same card as the screen's Disconnected message. The remote screen is centred on the stage and scaled into the space; the terminal has 12px top and 14px left padding on its ground. Spacing is a loose 4, 8, 12, 16, 20 rhythm with no formal scale in code. Safe-area insets are respected on every edge.

Full screen replaces the bar with a floating toolbar (48px, 12px radius, centred 10px from the top) and hides the wordmark. When idle it slides up out of view and a 64 by 18px handle remains at the top edge.

Phone (max-width 640px, or a touch screen under 500px tall): there is no top bar; the view fills the screen down to the tab bar, below the status-bar safe area, which stays the dark stage colour. A 56px bottom tab bar (44px with icon and label side by side in landscape) offers Machines, Screen, Terminal and More; a 8px warning or error dot on a tab's icon shows a view that is connecting or disconnected. More opens a sheet with a Show list (check mark on the current source) above the actions (keyboard, paste in the terminal, clipboard, Super, Ctrl+Alt+Del, reconnect, settings, full screen, or on iPhone Safari a sheet explaining Add to Home Screen). Settings becomes a bottom sheet with 16px top radius. On touch devices a key row (Esc, Tab, Ctrl, Alt, arrows, / - | ~, and Paste in the terminal) docks above the on-screen keyboard and replaces the tab bar while the keyboard is open; it is always shown in the terminal on phones unless set to Never.

## Elevation & Depth

Flat by default. Surfaces are separated by 1px hairlines and tonal steps between Ground, Surface and Surface Raised. One shadow exists for things that float over content.

### Shadow Vocabulary
- **Float** (`0 1px 2px oklch(0 0 0 / 0.06), 0 8px 24px oklch(0 0 0 / 0.12)` light; `0 1px 2px oklch(0 0 0 / 0.3), 0 12px 32px oklch(0 0 0 / 0.45)` dark): floating toolbar, toolbar handle, dialogs, sheets, toast.
- **Selected segment** (`0 0 0 1px var(--border), 0 1px 2px oklch(0 0 0 / 0.06)`): the raised pill inside a segmented control.
- **Key** (`0 1px 0 oklch(0 0 0 / 0.06)`): extra-key buttons.
- Backdrops are black at 40 to 55% alpha.

### Named Rules
**The One Float Rule.** Only elements that sit above the remote content use Float. Everything in the normal flow is flat with a hairline.

## Shapes

Rounded rectangles with small, consistent corners: 6px inside compact groups (segment items, the mark), 8px on controls (buttons, inputs, keys, toast), 12px on floating surfaces and grouped lists, 16px on the top edge of bottom sheets, and fully round for the status badge, switch and touch ring. Borders are always 1px; focus is a 2px primary outline offset by 2px. Icons are 16px (20 to 22px on phone surfaces) line glyphs with 1.75 stroke, round caps, drawn as an inline SVG sprite.

## Components

### Buttons
- **Icon button:** 32px square (40px on coarse pointers), transparent, secondary ink; hover adds Surface Raised fill, a hairline border and full ink; active uses Surface Pressed.
- **Text button:** the same, 32px high, 13px/500 label (for Ctrl+Alt+Del).
- **Primary:** 36px, 16px padding, Blue Fill as a slight vertical gradient (lightness +0.035 at the top, −0.035 at the bottom) with a Blue Ring outline, a 1px inner top highlight at 12% white and a 1px soft shadow; hover brightens by 6%. Used once, for Reconnect.

### Segmented control
- Surface Raised track with hairline, 3px padding, 8px radius. Items are 28px high, secondary ink; the selected item becomes a Surface pill with a hairline. Used for Screen/Terminal and, in a smaller 2px-padded variant, for Settings choices.

### Status badge
- 24px pill, Surface Raised, hairline, 12px/500 text, with a 7px dot coloured by connection state (busy pulses). Error state also turns the text red.

### Navigation
- Desktop: the top bar above, with a compact Show select before the screen tools. Phone: the bottom tab bar, 56px, 11px labels over 22px icons, selected item in Dashboard Blue.

### Floating toolbar
- The full-screen form of the top bar, described under Layout. It hides itself when idle and returns on interaction or via its handle.

### Extra key row
- Surface Raised strip with hairline top; keys are 36px high, min 44px wide, Surface fill, hairline, 8px radius. Ctrl and Alt are toggles that fill blue when pressed.

### Sheets, dialogs, toast
- Actions sheet: grouped list in a 12px-radius hairline container, 48px rows, 20px secondary icons, full-width Cancel below.
- Dialog card (Disconnected): 360px max, 20px padding, 12px radius, title, secondary body, one primary button on a 55% black overlay.
- Settings: 520px dialog with header, grouped sections divided by hairlines, 44px min field rows, selects (34px), range sliders, 40 by 24px switches and small segmented controls.
- Toast: Surface chip, 8px radius, bottom centre, fades in over 0.2s.

### Machines and dashboard
- **Machines view:** a toolbar (search field, sort select, List/Grid small segmented control, and Add machine as the view's one primary button), then the machines. List: one hairline-divided 12px container, a 60px row per machine with a drag grip, name (600) and a secondary line (This computer, system, uptime), the status badge, Processor and Memory figures with 4px grey meters, and Screen and Terminal text buttons. Grid: the same parts as 12px-radius cards. The machine being shown has a 3px blue inset on its left edge (selection). The grip appears only in Your order and without a search; arrow keys on it move the machine.
- **Dashboard:** a back button, the machine's name and line, its badge and text buttons, then 12px-radius cards in an auto-fill grid (min 320px): Processor, Memory, Pressure, Network, Disks, Storage, Graphics, Temperatures, Busiest processes. A card has a 13px/600 secondary title, at most one 16px/600 headline figure, and tables with 12px tabular figures and hairline rows.
- **Sparklines:** one series each, a 2px line in Ink Secondary over a hairline baseline, 56px high, ten minutes wide; percentages run 0 to 100, rates 0 to the window's peak. The row above names the series and reads "now · peak"; hovering shows a 1px crosshair and the value and time there. No colour, legend or fill: one series needs none, and blue stays for actions.
- **Meters:** 4px (6px for storage) Surface Pressed track with an Ink Secondary fill. Meters are never coloured by level; the number beside them carries the value.
- **Add a machine:** the dialog card at 560px with the install command in a mono, Surface Raised block (selects as one unit), the token's expiry, and Copy and Done.
- **No screen:** a machine without a screen shows a centred title, one line and Terminal and Machines text buttons in the Screen view; the badge reads No screen in the idle grey.

### Motion
Short and functional: 0.15s colour transitions on controls, 0.2 to 0.3s ease-out (`cubic-bezier(0.22, 1, 0.36, 1)`) for the toolbar, sheets, settings and toast, a 1.4s pulse on the busy dot, and a 0.18s touch-ring entrance. Reduced motion collapses all durations to near zero.

### App icon
The one brand asset, in `web/favicon.svg` and rendered to PNG by `scripts/make-icons.mjs`: a lowercase "d" whose bowl is a rounded screen with a text cursor inside, white strokes (2.6 units on a 32 box) on a diagonal blue gradient from #3d7bff to #1739c4, 8-unit corner radius. The top bar shows the same glyph at 24px on the same gradient.

## Do's and Don'ts

### Do:
- **Do** keep chrome neutral grey with 1px hairlines and let the remote screen and terminal be the loudest things on screen.
- **Do** use Dashboard Blue only for the primary action, selection, toggled state and focus.
- **Do** use state colours only to show connection state, and always pair them with the text label in the badge.
- **Do** size touch targets up on coarse pointers (40px icon buttons, 36px by 44px keys, 48px sheet rows).
- **Do** support both themes through the `--*` tokens and the `html[data-theme]` override; define new colours for both.
- **Do** use inline SVG line icons at 1.75 stroke and keep new controls to the 6, 8, 12px radius set.

### Don't:
- **Don't** add decorative elements, themed chrome, gradients or illustration to the interface; the gradient belongs to the app icon only.
- **Don't** tint the greys or introduce a second accent hue.
- **Don't** use shadows on in-flow surfaces; reserve Float for things above the remote content.
- **Don't** hide connection state or make it depend on colour alone.
- **Don't** load fonts or assets from outside the repo; CSP is `'self'` only.

<!-- Not canonized: the top bar is 52px in code but the direction contract said 48px (the floating toolbar is 48px); the dark token block is duplicated in CSS (media query and data-theme), so any token change must be made twice These are noted as drift, not design rules. -->
