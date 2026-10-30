# Dejavue: positioning, UVP and competitor comparison

> As of **2026-10-30**. Method: April Dunford, *Obviously Awesome*. Product facts come from this
> repo (README, `packages/core/src/types.ts`, `apps/bot`, `apps/web`); competitor facts from each
> vendor's public site, docs and published source code, with a source for every cell in §9.
> Re-check §9 before changing the comparison on the landing page
> (`apps/web/src/components/CompareSection.astro`): it is comparative advertising under §6 UWG /
> Directive 2006/114/EC, so every competitor claim must stay objective, verifiable and current.

**Owner's direction:** "Save money by automating Discord moderator work." Moderators of community
and product servers are volunteers or paid support staff, so the saving is the hours, and the
support cost, that stop going into answering the same question again.

---

## 1. Best-fit customers

Admins, moderators and support staff of **Discord servers that run a help or Q&A forum where the
same questions come back every week**:

- **Developer tools, SaaS and API products** with a community Discord: the same setup error, auth
  question or "is this a bug?" thread, asked by new users every week. Often answered by paid
  support or developer-relations staff, so repeats cost salary hours.
- **Open-source projects**: maintainers and volunteer helpers answer for free; every repeat costs
  them evenings and goodwill. They also want the code open and no lock-in.
- **Game studios and mod communities**: crash reports and "how do I…" threads at volume, run by
  volunteer mods.

What makes them love it: they already have a lot of solved threads (the raw material), they feel
the repeat-question load personally, and they don't have an enterprise support-tooling budget.
Communities that care about members' privacy (EU servers, open source) like the aliases, the
opt-in publishing and the option to self-host.

Not a fit: servers without a help channel, teams that want one AI assistant across docs, tickets,
Slack and their website (that's Kapa's game), and teams whose only goal is Google traffic from
Discord content (Answer Overflow does that for free).

## 2. Competitive alternatives

What a best-fit customer does today if Dejavue didn't exist:

1. **Status quo: answer by hand, with Discord's built-in forum search and tags.** A mod spots the
   repeat, digs up the old thread (or doesn't) and pastes a link or re-types the answer. Members
   are told to "search first". Discord forum search matches post titles; server search matches
   message keywords; tags are set by hand. This is the real competitor: it's free and already
   there, and its cost (mod hours) is invisible.
2. **Answer Overflow**: open-source (MIT) bot that turns forum posts and threads into public web
   pages so Google and AI assistants find them. Free and ad-supported on answeroverflow.com; the
   Advanced plan ($250/mo) adds a custom domain and removes ads. Inside Discord it has a
   "Mark Solution" command, a solved tag and a "View Similar Threads" button.
3. **Kapa.ai**: AI assistant that answers technical questions from a company's docs, code, tickets
   and community threads, with citations. Deploys as a website widget, Slack and Discord bots,
   Zendesk agent, MCP server and API. 14-day trial, then usage-based (Growth) or custom
   (Enterprise) pricing with an annual commitment; free or discounted for qualifying open-source
   projects.

**Omissions worth knowing (not in the table, the owner's column list stands):**
- **Canned-response / tag bots** (custom commands in general-purpose bots such as Carl-bot's tags):
  mods still have to spot the repeat and fire the right command. Closest to the status quo.
- **Other AI docs assistants** in the Kapa mould, e.g. Inkeep (Answer Overflow's own docs
  recommend it for AI answers). Same trade-offs as Kapa.
- **Moving support to a web forum or ticketing desk** (Discourse, Zendesk). A bigger switch than
  most Discord communities want.

## 3. Unique attributes (verified in the code)

What Dejavue has that the alternatives lack, or have only in part:

1. **Automatic duplicate check on every new forum post.** A few seconds after a post lands,
   Dejavue compares it with the server's solved threads (semantic, on every plan including Free)
   and replies in the thread with up to three matches.
   (`apps/bot/src/lib/dedup.ts`, `packages/core/src/types.ts` → `semanticSearch: true` on Free.)
   Answer Overflow shows similar threads only when someone clicks a button (title full-text
   search); Kapa generates an AI answer; Discord does nothing.
2. **One click closes the repeat with the earlier answer.** "Use this answer & close" posts the
   matched answer, marks the post solved and folds it under the original, so the knowledge base
   keeps one canonical page. "Not a duplicate" dismisses it. On Plus and up the reply also carries
   an AI-drafted answer. (`apps/bot/src/lib/embeds.ts` `duplicatesMessage`,
   `apps/bot/src/events/interactionCreate.ts` `setDuplicateOf`.)
3. **A knowledge base that fills itself from forums and regular text channels.** Mark-solved
   workflow (button, form, right-click, solved/unsolved tags swapped automatically); regular text
   channels are split into conversations, no threads or forum migration needed; `/dejavue rescan`
   imports history; `/dejavue search` inside Discord; an opt-in public site with QAPage JSON-LD
   on `{slug}.dejavue.app` or a custom domain (€29.99 once); MCP endpoint on Pro/Max.
   (`apps/bot/src/lib/trackedChannel.ts`, `apps/bot/src/events/messageCreate.ts`, README.)
   Kapa's Discord connector reads forum channels only; Answer Overflow indexes threads.
4. **Moderator automation around the loop:** stale-question nudges that ping a helper role,
   off-topic guard, knowledge-gap clustering and auto-FAQ, resolution rate / time-to-resolution /
   top helpers. (`/dejavue settings`, `/dejavue insights`.)
5. **Priced for volunteer-run communities, billed in Discord:** Free, then €4.99 / €9.99 /
   €24.99 per server per month through Discord Premium Apps; no card on Free.
6. **Open source and private by default:** AGPL-3.0; self-host with every feature unlocked
   (`DEV_FORCE_TIER=max`); duplicate detection and search run fully offline with local CPU
   embeddings; publishing is opt-in (`kb_publish_opt_in` defaults to `false`); public pages always
   show aliases ("Original poster", "Helper 1"), never Discord names.

Checked hypotheses from the brief:
- "Detects duplicate questions as they're asked and points to the earlier answer": **true**, in
  forum channels in *question* mode (the default).
- "Builds a searchable knowledge base from solved threads": **true**.
- "Works in regular channels as well as forums": **partly**. Regular text and announcement
  channels are indexed into search and the public site, but the live duplicate reply only runs in
  forum channels. The site copy says "help forums" for that reason.
- "Privacy / self-hosting": **true** (see 6).
- "Tiers": Free / Plus / Pro / Max as above. Semantic detection is on Free too (the README's
  "keyword on Free" line in *How it works* is outdated, see §11).

## 4. Value (attribute → benefit → proof)

### Theme A: Repeat questions answer themselves
- **Attributes:** automatic duplicate check (1), one-click close (2), AI draft on Plus+, stale
  nudges (4).
- **Benefit:** moderators and support staff stop re-typing answers and hunting for old threads;
  askers get an answer in seconds instead of waiting for someone to come online. Volunteer hours
  and paid support time go to questions nobody has answered yet.
- **Proof:** the reply shows "Found in N s"; `/dejavue insights` shows resolution rate and time
  to resolution before and after. (No published "hours saved" figure exists yet; see §12.)
- **How to talk about the saving (internal model, not a site claim):** hours saved per month ≈
  repeat questions per week × minutes per manual answer × 4.3. Example: 20 repeats a week at
  5 minutes each is about 7 hours a month of moderator time.

### Theme B: Every answer is written once and reused everywhere
- **Attributes:** mark-solved workflow, text channels, history import, `/dejavue search`, public
  SEO site, MCP, auto-FAQ and gap clustering (3).
- **Benefit:** the community's answers become a searchable FAQ in Discord, on Google and in
  members' AI assistants, without anyone writing docs by hand. Gap clusters show which docs to
  write next.
- **Proof:** QAPage/FAQPage JSON-LD and sitemaps per site; live demo on the landing page.

### Theme C: Affordable, open and yours
- **Attributes:** Free plan with semantic detection, €4.99–€24.99/mo per server billed in Discord,
  AGPL, self-hosting, offline mode, aliases and opt-in publishing (5, 6).
- **Benefit:** a volunteer-run server can afford it and keep it; no sales call, no annual
  contract, no lock-in; members' names never end up on the web.
- **Proof:** public source code; privacy policy; pricing on the site.

## 5. Target market characteristics

Who cares most about that value:
- A help forum with **dozens of new questions a week** and a visible share of repeats.
- Answers come from **a small group** (a few mods, a DevRel or support person) who feel the load.
- **Budget-constrained:** open-source projects, indie and mid-size game studios, early-stage
  SaaS. Enterprise-tool pricing (usage-based contracts, $250/mo add-ons) is out of reach or out of
  proportion.
- **Discord-native:** they want the fix inside Discord, not a new support desk.
- Often **EU-based or privacy-minded**, or open-source by conviction.

## 6. Market category

**Style: big fish in a small pond.** Category: *the duplicate-question bot for Discord help
forums*, a subcategory of Discord support bots.

Why this frame:
- "AI support assistant" puts us next to Kapa and Inkeep, where buyers expect docs ingestion
  across 30+ sources, SOC 2 and sales-led contracts. We'd lose that comparison and confuse the
  volunteer buyer.
- "Discord to Google indexing" is Answer Overflow's established, free category. We do it too, but
  it isn't why a mod installs us.
- "Moderation bot" makes Discord admins think of spam, roles and auto-mod (MEE6, Carl-bot, Dyno).
- The subcategory names the pain the buyer already feels (the same question again), it's the
  phrase the site already ranks for ("Discord Duplicate Question Bot & Knowledge Base"), and
  among the named alternatives Dejavue is the only one that answers the repeat automatically in
  the thread.

## 7. Relevant trend

Support moved into Discord (forum channels exist on 100% of Community servers per Discord's
Forum FAQ), where answers are invisible to search engines and AI assistants unless something
exports them. Both named competitors now ship MCP servers (Answer Overflow's README; Kapa's
"Introducing Kapa MCP"), so "your answers inside Claude/ChatGPT" is becoming table stakes rather
than a differentiator. Use the trend to explain the knowledge-base half of the product, not as the
headline.

## 8. Positioning statement and UVP

**Positioning statement.** For moderators and support staff of Discord help communities who
answer the same questions over and over, Dejavue is a duplicate-question bot that replies to a
repeat question with the community's earlier answer the moment it's posted, and files every
solved thread into a searchable knowledge base. Discord's forum search depends on members
searching first, Answer Overflow publishes threads to the web for Google, and Kapa.ai is an AI
docs assistant priced by usage; Dejavue works inside the thread, starts free, costs €4.99 to
€24.99 per server a month, and is open source.

### UVP

| | English | Deutsch |
|---|---|---|
| **Headline** | Stop paying for the same answer twice. | Jede Antwort nur einmal bezahlen. |
| **Subheadline** | Dejavue spots repeat questions in your Discord help forums as they're posted and replies with the answer your team already wrote. Moderator hours and support budget go to new problems instead. | Dejavue erkennt wiederholte Fragen in deinen Discord-Hilfeforen, sobald sie gestellt werden, und antwortet mit der Lösung, die dein Team schon geschrieben hat. So fließen Moderationsstunden und Support-Budget in neue Probleme. |

"Paying" covers both buyers: paid support pays in salary, volunteers pay in evenings. Shorter
alternates from the brand brief, for social and the Discord App Directory: "Never answer the same
question twice." / „Keine Frage mehr zweimal beantworten."

The site ships English only (`<html lang="en">`); the German lines are for German-language
channels (social, newsletter, a future `/de` page).

### What do we do better? (the owner's open question)

1. **We act when the repeat is asked, in the thread.** The others act elsewhere or later: Discord
   search waits for the member to search first; Answer Overflow serves Google visitors and shows
   similar threads in Discord only on a button click; Kapa answers from docs with generated text.
   Dejavue replies within seconds with the community's own solved thread and lets the asker close
   the post with that answer in one click.
2. **One tool covers the whole loop for moderators:** detect, solve, archive, search, publish,
   nudge, measure. Answer Overflow covers solve and publish; Kapa covers answer; Discord covers
   none of it automatically.
3. **It learns from regular text channels too**, without forcing a forum migration or a thread
   per message.
4. **It fits a volunteer budget:** semantic duplicate detection on the free plan, paid plans from
   €4.99/mo billed inside Discord, a custom domain for €29.99 once (Answer Overflow: $250/mo plan;
   Kapa: usage-based after a 14-day trial).
5. **Open source, self-hostable with every feature, and private by default** (opt-in publishing,
   aliases always on). Answer Overflow is MIT-licensed but lists self-hosting as a future option
   and shows names unless a server turns anonymizing on; Kapa is a hosted service.

Where we are **not** better, said plainly: Kapa ingests far more sources (docs, code, tickets,
50+ connectors), has SOC 2 Type II and deploys beyond Discord. Answer Overflow is free with
unlimited page views, has a large network and brand on answeroverflow.com, a more permissive
licence (MIT), and is used by large servers. Discord's search is free and needs no install.

## 9. Competitor table data (landing page)

As of **2026-10-30**. Marks: ✓ yes · ◐ partly · ✕ no · — not listed or not applicable.
Source keys are listed below the table.

| Criterion | **Dejavue** | Answer Overflow | Kapa.ai | Discord forums (built in) |
|---|---|---|---|---|
| Replies to a repeat question with the earlier answer | ✓ Automatically, with one-click close [D1] | ◐ On request, via a "View Similar Threads" button [A1] | ◐ AI answer from your indexed sources [K1] | ✕ Members search post titles themselves [C1] |
| Mark-solved workflow with solved tags | ✓ Button, form or right-click; tags swap automatically [D2] | ✓ "Mark Solution" command and solved tag [A2] | — Not listed [K2] | ◐ Tags and closing, by hand [C1] |
| Covers regular text channels, not only forums | ✓ Splits the chat into conversations [D3] | ◐ Threads only; can open one per message [A3] | ✕ Imports Discord forum channels only [K3] | ◐ Keyword message search [C2] |
| Public help site that Google can index | ✓ Free subdomain; own domain €29.99 once [D4] | ✓ Hosted by Answer Overflow; own domain $250/mo [A4] | ✕ Answers via widget, bots and API [K4] | ✕ Visible to server members only [C1] |
| Hides members' Discord names on public pages | ✓ Always, as aliases like "Helper 1" [D5] | ◐ Optional setting, off by default [A5] | — No public pages [K4] | — No public pages [C1] |
| Open source and self-hostable | ✓ AGPL-3.0; every feature when self-hosted [D6] | ◐ MIT-licensed code; self-hosting planned [A6] | — Hosted service, EU or US region [K5] | — Part of Discord |
| Price | Free plan; ad-free from €4.99/mo per server [D7] | Free with ads; Advanced plan $250/mo [A4] | 14-day trial, then usage-based; open-source program [K6] | Included with Discord |

Footnote shown under the table: "Comparison based on each vendor's public website, documentation
and published source code as of October 2026. Trademarks and logos belong to their owners.
Spotted a mistake? contact@wksolutions.de"

### Sources

**Dejavue (this repo)**
- **D1** `apps/bot/src/lib/dedup.ts` (debounced check on every new post in a monitored question
  forum, hybrid semantic search, up to 3 matches); `apps/bot/src/lib/embeds.ts`
  `duplicatesMessage` ("Use this answer & close", "Not a duplicate");
  `packages/core/src/types.ts` (`semanticSearch: true` on every tier).
- **D2** README "How it works" §2–3 and "Solving & archive"; `apps/bot/src/lib/solve.ts`.
- **D3** `apps/bot/src/lib/trackedChannel.ts` (segments by 20-minute gaps),
  `apps/bot/src/events/messageCreate.ts`; README tier table "Tracked (non-forum) channels".
- **D4** README "Public website", "Tiers" (custom domain €29.99 one-time, any tier).
- **D5** `apps/web/src/components/legal/PlatformPrivacy.astro` §2 and §5; README "Privacy".
- **D6** `LICENSE` (AGPL-3.0); README "Self Hosting" (`DEV_FORCE_TIER=max`, "no feature gating").
- **D7** README "Tiers"; `apps/web/src/pages/index.astro` `tiers`; `packages/core/src/types.ts`
  (`ads: true` on Free only).

**Answer Overflow.** answeroverflow.com and docs.answeroverflow.com answered automated requests
with a Vercel security checkpoint (HTTP 429) on 2026-10-30, so these claims were verified in its
public MIT repository (github.com/AnswerOverflow/AnswerOverflow, `main`, last push 2026-10-22),
which contains the bot, the docs and the website's pricing section. A human should glance at the
live pages before each update.
- **A1** `apps/discord-bot/src/services/send-mark-solution-instructions.ts` (adds the "View
  Similar Threads" button to the instructions message in new threads when indexing is on);
  `apps/discord-bot/src/interactions/similar-threads-button.ts` (on click: ephemeral list of up to
  4 similar threads by title, "This Solved It" marks the post solved via that link);
  `packages/database/convex/public/search.ts` ("full-text search").
- **A2** docs.answeroverflow.com/channel-settings/mark-solution and /solved-tag
  (`apps/docs/channel-settings/mark-solution.mdx`, `solved-tag.mdx`).
- **A3** docs.answeroverflow.com/channel-settings/auto-thread ("It's extremely hard to index
  content in a regular text channel with no threads…"; creates a thread for every message);
  README ("Creates indexed web pages from threads").
- **A4** answeroverflow.com/about#pricing (`/pricing` redirects there, `apps/main-site/next.config.ts`):
  Free, "Hosted on answeroverflow.com", "Ad supported", "Unlimited page views"; Advanced $250 /
  month: custom domain, ad free, 14-day trial (`apps/main-site/src/app/(main-site)/about/client.tsx`).
- **A5** `packages/database/convex/shared/servers.ts` (`anonymizeMessagesEnabled: false` default),
  `packages/database/convex/shared/messagePrivacy.ts`; docs.answeroverflow.com/user-settings/displaying-messages
  (messages in indexed channels public by default, users opt out with `/manage-account`).
- **A6** `LICENSE.md` (MIT); about page FAQ "What if I cancel my subscription?" ("In the future,
  you'll also have the option to self-host Answer Overflow.").

**Kapa.ai**
- **K1** docs.kapa.ai/integrations/discord-bot ("responds to direct mentions, and in forum
  channels it can answer every new post automatically"); docs.kapa.ai/integrations/discord-bot/configuration
  (forum auto-reply mode, off by default); kapa.ai (answers grounded in indexed sources, cited).
- **K2** The Discord bot docs (integration, quickstart, configuration) list no solved/mark-answer
  feature.
- **K3** docs.kapa.ai/knowledge-sources/connectors/discord ("This integration supports only Discord
  channels of type `Forum`").
- **K4** kapa.ai/llms.txt surfaces: "website widget, Slack and Discord bots, support form
  deflector, Zendesk agent, internal employee assistant, hosted MCP server, chat SDK and HTTP API"
  (no public pages generated from Discord threads).
- **K5** kapa.ai home ("EU/US Data regions"); kapa.ai/pricing (Enterprise: "EU and regional
  hosting"). The on-prem FAQ answer isn't in the page source, so the table says "Hosted service"
  and makes no self-hosting claim.
- **K6** kapa.ai/pricing (Free trial "$0 for 14 days", Growth "Usage-based… Platform fee plus
  committed answers", Enterprise "Custom"); kapa.ai/llms.txt ("usage-based, with a minimum annual
  commitment for commercial plans"); docs.kapa.ai/kapa-for-open-source ("at a discounted rate or
  entirely free of charge").

**Discord (built in)**
- **C1** support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ (updated
  2026-10-26): forum search by "key word or phase of the post title", tags and tag filters, post
  guidelines, close/lock a post by hand, permissions limit forum access to server members/roles.
- **C2** support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord (updated
  2026-10-29): keyword message search within a server with user/date/channel filters.

## 10. Store version (generic alternatives only)

Dejavue has **no App Store listing** (web product, brief §5 skipped). The same rule is sensible
for the **Discord App Directory** listing and other marketplaces: no competitor names or logos,
only generic alternatives.

| | **Dejavue** | Answering by hand | Built-in forum search & tags | Bots that publish threads to the web | AI docs assistants |
|---|---|---|---|---|---|
| Replies to a repeat question with the earlier answer | ✓ Automatically, in the thread | ✕ When a mod notices | ✕ Only if the member searches first | ◐ Some list similar threads on request | ◐ Generated answer from your docs |
| Closes the repeat in one click | ✓ | ✕ | ✕ | ◐ | ✕ |
| Mark-solved workflow with solved tags | ✓ Automatic tags | ✕ | ◐ By hand | ✓ | — |
| Learns from regular text channels too | ✓ | — | ◐ Keyword search | ◐ Usually threads only | ◐ Often forums only |
| Searchable knowledge base, in Discord and on the web | ✓ | ✕ | ◐ In Discord only | ◐ On the web | ◐ Via the assistant |
| Open source and self-hostable | ✓ | — | — | ◐ Varies | ✕ Usually hosted |
| Price | Free; from €4.99/mo per server | Mod hours | Free | Free with ads to paid plans | Usually usage-based contracts |

Directory copy, ≤190 chars: "Dejavue answers repeat questions in your Discord with the answer your
community already wrote, then files every solved thread into a searchable knowledge base. Free to
start."

## 11. Inconsistencies found while verifying (not part of the positioning)

- README "How it works" step 1 and "Duplicate detection & search" still say keyword on Free,
  semantic on Plus+; `packages/core/src/types.ts` gives every tier semantic search. The README
  tier table is right.
- MCP: README "MCP Server" section and the privacy policy (§8) say Max; `types.ts` and the pricing
  cards say Pro and Max. The landing page MCP badge was changed to "PRO & MAX" with this update.
- KB thread pages (`apps/web/src/pages/c/[channel]/[thread].astro`) tell Free readers "Pro & Max add a clean AI summary",
  while `types.ts` gives Plus `kbSummarizedAnswers: true` as well.
- Fixed on the landing page with this update: the pricing intro said "Keyword features are free
  forever. Semantic search anchors the middle" (Free has semantic search), and the open-source
  card said "No analytics" (knowledge bases count traffic with cookieless PostHog; it now says
  "No tracking cookies, no visitor profiles").

## 12. Open items

- No measured "hours saved" or "duplicates closed" metric exists yet. `/dejavue insights` has
  resolution rate and time-to-resolution but doesn't count accepted duplicate suggestions. Adding
  that count would turn Theme A's proof from a model into a number we can publish.
- Re-verify Answer Overflow's live pricing page by hand (bot checkpoint blocked automated fetches).
- Kapa's open-source program terms and Growth price aren't public; keep the cell generic.
