# Dejavue — Brand & Store Asset Design Brief

> Working brief for producing every visual asset Dejavue needs: app icon, Discord
> profile, App Directory store listing, website, and social. Hand sections to Claude
> (`/frontend-design` for the website + UI mockups, an image-generation tool for
> illustrative backgrounds) or to a human designer. It is opinionated on purpose so
> output stays consistent across surfaces.

---

## 0. Name & capitalization (decided)

- **Canonical brand name:** **Dejavue** — single initial capital, one coined word.
- **Logo wordmark + all code/URLs:** lowercase **`dejavue`** (`@dejavue/*` packages, the
  `/dejavue` command, `*.dejavue.app` subdomains).
- **Not** "DejaVue" (camelCase). The capital V foregrounds **"Vue,"** which our developer
  audience reads as Vue.js — a framework affiliation the product doesn't have, plus needless
  SEO collision. "Dejavue" also maps cleanly to the already-lowercase code conventions and
  reads as more modern (Vercel/Linear/Resend-style). Pronunciation is identical either way.

---

## 1. The core idea (read first)

**Dejavue** plays on *déjà vu* — "haven't I seen this question before?" That is literally what
the bot does: it recognizes the repeat question, surfaces the answer that already exists, and
files solved threads into a knowledge base. Every visual encodes one metaphor:

> **The Echo** — a thing and its faint duplicate. One crisp and answered; one a ghost behind it.

- **Personality:** smart, calm, a little magical — *not* loud or gamer-y. A developer/community
  productivity tool, closer to Linear / Notion / Vercel polish than to a meme bot.
- **Audience:** admins and mods of help/support forums — dev tools, SaaS communities, game
  studios, open-source projects.
- **Feeling:** "this just quietly makes my server smarter."

---

## 2. Visual system

### Logo / icon concept — "The Echo" (primary, recommended)

Two speech bubbles: a **ghost bubble** offset behind (the unanswered duplicate) and a **solid
front bubble** containing a **checkmark** (the solved answer). Simple enough to read at 24px,
meaningful, and ownable. Together they also hint at a soft "D."

*Alternates if options are wanted:* (a) a magnifier over two stacked cards; (b) a "déjà" ripple —
concentric rings from a single bubble. Recommend **The Echo**.

### Color palette (locked)

| Role | Name | Hex |
|---|---|---|
| Primary | Indigo | `#4F46E5` |
| Primary 2 | Violet | `#7C3AED` |
| Echo / ghost | Light Violet | `#A78BFA` |
| Success / "solved" accent | Mint | `#2DD4BF` |
| Dark surface | Ink | `#0E0F1C` |
| Raised surface | Slate | `#1B1D33` |
| Text on dark | Cloud | `#F4F5FF` |
| Muted text | Fog | `#9AA0C3` |

- **Signature gradient:** 135°, `#4F46E5 → #7C3AED` (push to `#9333EA` for a richer variant).
- We sit *adjacent* to Discord blurple (`#5865F2`) so it feels native, but lean **violet** to
  stay distinct in a directory full of blue bots.

### Typography

- **Wordmark / display:** Space Grotesk (or Satoshi) — geometric, techy but warm. Use the
  **lowercase `dejavue`** wordmark.
- **UI / body:** Inter.
- **Optional mono accent:** Geist Mono / JetBrains Mono for code-flavored detailing.

### Do / Don't

- ✅ Generous negative space; flat or subtle-gradient shapes; rounded geometry (match Discord's UI radius).
- ✅ The echo element is always lower opacity than its source.
- ❌ No literal eyeballs (clichéd/creepy for "déjà vu"). No drop-shadow soup, no skeuomorphism, no clip-art robots.
- ❌ No small text inside the icon — it dies at avatar size.

---

## 3. App icon (single most important asset)

The bot avatar **and** the directory grid thumbnail. Discord masks it to a **circle** — design
circle-safe.

- **Canvas:** 1024×1024, rounded-square "squircle" tile filled with the **135° indigo→violet gradient**.
- **Composition:** centered within a **~78% safe circle**.
  - *Echo bubble:* offset up-left ~8–10%, `#A78BFA` or white @ ~25% opacity, empty.
  - *Front bubble:* `#F4F5FF`, crisp, containing a **mint `#2DD4BF` checkmark**.
- **Squint test:** must still read as "two bubbles + a check" at 32px.
- **Variants to deliver:** (1) full-color tile; (2) white monochrome on transparent (stamps/footers);
  (3) inverted dark-on-light (light backgrounds / the KB).

> **Build the icon as vector (SVG), not AI-raster.** Image-model logos warp at small sizes and
> export inconsistently. Have Claude produce clean **SVG** from the geometric spec above (or build
> in Figma). Use image generation only for the *illustrative* assets in §6–7.

---

## 4. Wordmark & "powered by Dejavue" lockup

- **Wordmark:** lowercase `dejavue` in Space Grotesk Medium, tight tracking; Cloud-on-dark and Ink-on-light versions.
- **Horizontal lockup:** the two-bubble glyph (no tile) + wordmark, for site headers.
- **"powered by Dejavue" stamp:** tiny lockup for **free-tier embed footers** and **KB page footers** —
  muted (`#9AA0C3`), unobtrusive, ~140×24 @2×, light + dark. This is a real viral surface (it appears
  on every free server's embeds and every public KB page), so it must look classy, not spammy.

---

## 5. Discord profile assets

| Asset | Size | Notes |
|---|---|---|
| Bot avatar | 1024×1024 | = the app icon (§3) |
| App profile banner | 1024×480 (upload 2×) | gradient field with a faint large echo-ripple motif + wordmark left-aligned; keep the right side clean for Discord's overlaid text |
| "About Me" (≤190 chars) | text | see §6 copy |

---

## 6. Discord App Directory listing

### Visual assets

| Asset | Recommended size | Format | Content |
|---|---|---|---|
| Listing icon | 1024×1024 | PNG | the app icon |
| Cover / hero banner | 1920×1080 (16:9) | PNG/JPG | dark Ink background, signature gradient glow, wordmark + tagline, a hero render of the "duplicate detected" embed floating with a soft echo behind it |
| Carousel screenshots (up to 5) | 1600×900 (16:9) | PNG | **real product mockups**, one feature each (below) |

> ⚠️ Confirm exact max dimensions/aspect in the Developer Portal submission form before final export —
> Discord adjusts these periodically. 16:9, the icon at 1024², and PNG are the safe defaults.

### Carousel — one polished mockup per slide (real UI, not abstract art)

1. **"Déjà vu detected"** — the bot's embed on a new post: *"I've seen this before"* + 3 matched threads + buttons. (Hero shot.)
2. **One-click solved** — the forum post tag flipping from 🔴 `unsolved` → ✅ `solved`.
3. **`/dejavue search`** — slash-command results pulling answers from the archive.
4. **AI-drafted answer (Pro)** — a drafted reply sourced from past solved threads, labeled "AI draft."
5. **Public knowledge base** — a clean `acme.dejavue.app` FAQ page in a browser frame (the SEO payoff).

Each slide: dark canvas, mockup in a rounded device/window frame, one short Space Grotesk caption,
gradient accent. Keep a consistent template across all five.

### Copy to ship with the listing

- **Tagline (pick one):** *"Never answer the same question twice."* / *"Your community already answered this."*
- **Short description (~190 chars):** "Dejavue spots duplicate questions the moment they're posted,
  surfaces the answer from past solved threads, and turns your forum into a searchable, SEO-ready knowledge base."
- **About Me (≤190):** "I catch repeat questions, point to the answer that already exists, and file every
  solved thread into a searchable knowledge base. Déjà vu, handled."
- **Long description:** lead with the pain (repeat questions drown your mods) → the loop (detect → solve →
  archive → search) → the AI layer (semantic dedup, drafted answers, summaries) → the free public KB → tier
  table. Use the §1–2 voice.
- **Suggested categories:** Productivity / Utilities / Moderation.

---

## 7. Website & social (dejavue.app)

| Asset | Size | Notes |
|---|---|---|
| Landing hero | full-bleed, art ~2400×1200 | Ink bg, gradient aurora, large Echo motif; subtle animated ripple if built with `/frontend-design` |
| Open Graph / share image | 1200×630 | wordmark + tagline + icon on gradient; renders when the link is shared |
| Favicon | SVG + 512/32/16 PNG + `.ico` | simplified glyph (front bubble + check only — the echo is too fine at 16px) |
| KB page header/footer | — | light theme; wordmark top-left, "powered by Dejavue" footer (§4); must look trustworthy (public + Google-indexed) |

Build the website and these mockups with **`/frontend-design`** so the marketing UI matches the real
product UI (same fonts, colors, radii).

---

## 8. Master asset checklist

| # | Asset | Size | Format | Vector or raster? |
|---|---|---|---|---|
| 1 | App icon (+3 variants) | 1024² | PNG/SVG | **vector** |
| 2 | Wordmark + horizontal lockup | scalable | SVG | **vector** |
| 3 | "powered by" stamp (light/dark) | ~140×24 @2× | SVG/PNG | **vector** |
| 4 | Discord profile banner | 1024×480 | PNG | raster bg + vector type |
| 5 | Directory cover/hero | 1920×1080 | PNG | raster bg + vector type |
| 6 | Carousel mockups ×5 | 1600×900 | PNG | UI mockups |
| 7 | OG / share image | 1200×630 | PNG | raster bg + vector type |
| 8 | Favicon set | 512/32/16 + ico/svg | PNG/SVG | **vector** |
| 9 | Website hero | ~2400×1200 | SVG/PNG | mixed |

---

## 9. Ready-to-use generation prompts

**Icon (give to Claude to produce as SVG):**

> "Generate a clean SVG app icon, 1024×1024, rounded-square tile filled with a 135° linear gradient
> from #4F46E5 to #7C3AED. Centered within the inner 78%: two rounded speech bubbles with small tails.
> A back 'echo' bubble offset up-and-left ~9%, filled #A78BFA, empty. A front bubble filled #F4F5FF
> containing a bold mint #2DD4BF checkmark. Flat, geometric, no gradients on the bubbles, no text. Must
> read clearly at 32px. Also output a white-monochrome-on-transparent variant."

**Directory hero / cover (image-gen):**

> "Premium SaaS product banner, 1920×1080, deep near-black #0E0F1C background with a soft
> indigo-to-violet aurora glow (#4F46E5→#7C3AED) in the upper right. A large, faint concentric-ripple
> 'echo' motif radiating from the center-left. Clean, minimal, lots of negative space, Linear/Vercel
> aesthetic. No text, no characters, no logos — leave the lower-left third clean for overlaid wordmark
> and tagline."

**OG / share image (image-gen background, then overlay type):**

> "1200×630 social share card background: dark #0E0F1C with a 135° #4F46E5→#7C3AED gradient panel on the
> right third and a subtle ripple texture. Minimal, modern, space for a left-aligned logo and one line of
> headline text. No text in the image itself."

**Carousel mockups (use `/frontend-design`, not image-gen):**

> "Render a realistic Discord message embed for a forum post titled '[example question]'. The bot embed
> header reads 'I've seen this before' with the Dejavue icon, lists 3 matched solved threads each with a
> similarity %, and has two buttons: '✅ This solved it' and '🙅 Not a duplicate'. Use Discord dark theme.
> Then place it in a 1600×900 frame on an Ink #0E0F1C background with a Space Grotesk caption 'Catches
> duplicates the moment they're posted.' and a violet accent bar."
>
> *(Repeat, swapping the embed content, for slides 2–5 in §6.)*

---

## 10. Decisions to confirm before generating

1. **Icon concept:** The Echo (recommended) vs. the alternates in §2.
2. **Palette:** the violet system above (recommended) vs. hugging Discord blurple more closely.

Once both are locked, every asset in §8 falls out consistently.