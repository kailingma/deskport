---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/app.js","public/style.css"]
---

# deskport app shell

Scope: the whole single-page app (top bar, Screen view, Terminal view, full-screen toolbar, phone layout). Mode: Operate.

Audience and job: the owner, on iPhone Safari, iPad or a laptop, checking on and controlling their own always-on desktop and tmux session in short visits.

Constraints: no build step, CSP 'self' only (fonts served from node_modules), iPhone has no Fullscreen API or Keyboard Lock. The user rejected decorative directions and asked for simple and corporate, sitting next to the Cloudflare dashboard (then Vercel, Tailscale). Floating toolbar is welcome on desktop.

## Direction contract

THESIS: deskport looks like a page of the Cloudflare dashboard that happens to hold a live desktop. It refuses ornament, themed chrome and anything that competes with the remote screen.

OWN-WORLD: Inter Variable. Neutral greys (no tint) for ground, surface and hairlines, one blue for primary actions and selection, green, amber and red only for connection state. 8px radius on controls, 12px on floating surfaces, 1px borders, one soft shadow for floating surfaces. Light and dark follow the system.

STORY: the visitor sees which machine they are on and whether it is connected, switches between Screen and Terminal, and reaches the few desktop keys (Super, Ctrl+Alt+Del, clipboard) without hunting.

FIRST VIEWPORT: desktop: a 48px bar with mark, name and host on the left, a Screen/Terminal segmented control in the centre, connection status and icon buttons on the right; the remote screen fills everything below. Full screen: the bar is replaced by a compact floating toolbar centred at the top, collapsing to a small handle when idle. Phone: compact top bar with host and status, the view below, a bottom tab bar (Screen, Terminal, Keys) above the home indicator, and a key row (Esc, Tab, Ctrl, Alt, arrows) docked above the on-screen keyboard.

FORM: canon (the category standard, user-steered), executed at full craft; seed: seed:509374f1754bce19.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
