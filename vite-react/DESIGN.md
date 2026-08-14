# Design System: Neutral Modern

> Category: Starter · Calm, functional, quietly confident. Content-first, chrome-second. No ornament.

**This project ships a design system. Use it; do not reach for raw Tailwind color utilities.**
When in doubt, subtract.

## 1. The rule that matters most: use the semantic tokens, never raw colors
- `bg-background`, **never** `bg-white` (the page is off-white, not pure white).
- `text-foreground` (not `text-gray-900`); `text-muted-foreground` (not `text-gray-600` / `text-slate-*`).
- `bg-primary` / `text-primary` for the accent; **never** `text-indigo-*` / `text-violet-*` / `text-purple-*` / a second `text-blue-*`. AI-indigo (`#6366f1`) is the **#1 AI-slop tell**; this design uses one cobalt accent only.
- `border-border`, `bg-card`, `ring-ring` for borders / cards / focus.
- Don't invent hex outside the palette.

## 2. Color & roles
`--background` off-white `#fafafa` (never pure white) · `--foreground` off-black `#111` (never pure black) · `--primary` cobalt `#2f6feb` (the one accent, used ≤2× per screen: the hero element + the CTAs, locked page-wide) · `--muted-foreground` `#6b6b6b` · `--border` `#e5e5e5` · `--card` white · `--destructive` red. Budget: ~70-90% neutral / 5-10% accent / <5% semantic.

## 3. Typography
Body 16px, line-height 1.5; headings tight (1.2). **≤3 type sizes per screen**; control hierarchy with weight + color, not raw size. Don't default everything to 700-bold. Display type gets slightly negative tracking.

## 4. Layout & depth
4px spacing grid; **section padding ≥80px desktop**. One radius scale (`--radius`). **≤3 elevation levels** (flat / 1px ring / one soft shadow); shadows tinted to the bg, never pure-black; no neumorphism/glass-everywhere. Whitespace separates before borders, borders before shadows. One theme per page (no mid-scroll inversion). Don't center everything; vary section layouts, and a layout family appears ≤1× per page.

## 5. Do / Don't
✅ semantic tokens · one cobalt accent · off-white bg · neutral grays · a real hero visual · varied section layouts · concrete copy with real/labeled numbers.
❌ `bg-white` / `text-indigo-*` / `text-gray-*` raw utilities · two accents · pure white/black · three identical centered feature cards · everything centered · **no em-dashes or en-dashes anywhere** (use a hyphen, a comma, or two sentences) · `picsum` random photos as the hero · div-based fake screenshots · empty adjectives ("Elevate / Seamless") · Lorem / "Acme" / "John Doe".
