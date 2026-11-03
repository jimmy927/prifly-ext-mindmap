# Mind map for prifly

A live, self-updating radial mind map of your prifly sessions, the conversations
they are about and their Trello cards. Click **Mind map** in prifly's status bar
and it opens over nearly the whole window.

- **All sessions** sits in the middle. Around it, on an ellipse, are 6 to 9
  **themes**: what the work is about, whatever service it came from - a session,
  the WhatsApp chat and the mail about the same person or product sit in one
  theme. Each session, conversation and card hangs off its theme, with its
  title in bold and two short summary lines.
- A dot on each session's rim says how it stands: green running, amber waiting
  on you, red error, grey idle or snoozed.
- **Solid arrows** are links prifly knows: a session _started_ another, a
  session _waits on_ another, a card is a session's _ticket_. **Dashed curves**
  with an italic label join items about the same thing, labelled by what they
  share: the person's first name, the repository, the ticket id - or, for a
  pair only the model sees, its 1-2 words.
- Conversations and cards are smaller circles, ringed in their service's
  colour. A legend runs along the bottom; the footer says which model made the
  topics ("Topics by claude-haiku via Claude") and which sources could not be
  read.

Clicking a session opens it in prifly. Clicking a card opens it in Trello, and a
conversation opens its link when its tool gave one. The map never sends a
message or changes anything.

## How it stays current

The page asks for the map every 5 s while it is visible, and not at all while it
is hidden; nothing is read for a closed map. Each ask starts what is due:

| What                                                                                             | How often                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Sessions (`api.sessions()`)                                                                      | every 15 s, so a new session shows within 15 s         |
| WhatsApp, Gmail (`newer_than:3d`), Outlook (received in the last 3 days), Telegram, Trello cards | every 5 min                                            |
| Instagram, LinkedIn, Messenger (they drive your browser)                                         | every 15 min                                           |
| Grouping and naming (`api.llm.ask`, the fast tier)                                               | one call when the items changed, at most once a minute |
| Summary lines (`api.llm.ask`, the fast tier)                                                     | batches of 20, only for items whose text is new or changed, one batch per page ask |

Each source is one listing call through `api.tools.read` - never a loop over
threads, and nothing is marked read. A missing or failing source is skipped and
named in the footer. Every conversation the listings give is matched against the
sessions; up to 20 are drawn - those that match a session best first (recency
only breaks ties), then any with a message in the last 3 days - and up to 15
cards, those with a session first, then the best matches. Ended leftovers
(untitled sessions, agent reports, prifly's summariser folds) are left out, and
at most 40 sessions are drawn.

Conversations and cards need prifly's `read-tools` feature, and the solid links
and brief summaries its `session-facts` feature. On a prifly without them the map
shows sessions only.

## The themes

The model groups and names. Shared entities are the only thing worked out in
code, and they only help the model:

1. **Shared entities, no model** (`entities.ts`). People (a chat's name, a mail's
   sender and address, a WhatsApp number), mail domains, repositories, card
   names, ticket-like ids (`SHOP-12`, `prifly-541`) and rarer words are read out
   of each item's title, brief lines, name, subject and last message. A person
   is also found by their first name in another item's text ("Reply to Ada").
   Two items that share one make a pair with a label ("Ada", "SHOP-12"). A
   service's name is never an entity, and one on more than 4-6 items (the
   reader's own name, a surname, a word every mail has) ties nothing. The pairs
   also decide which conversations and cards are drawn (the ones that match a
   session best first).
2. **The grouping call** (`grouping.ts`, `sorting.ts`). Each refresh where the
   items changed - their ids, titles, repositories, brief lines and, for a
   conversation, its name, subject and the start of its last message - the
   extension makes one `api.llm.ask` call on prifly's **fast tier**. It is kept
   small: the items go by short ids (`i1`, `i2`, ...) with only what grouping
   needs (kind, title, repository, up to two brief lines of 50 characters; for a
   conversation its name, subject and the first 120 characters of its last
   message), and two hints: the shared-entity pairs with their labels, and the
   previous topics (id, name, members) so topics keep their ids and names while
   their members stay. It passes a JSON Schema and asks for the topics (`id`,
   `name`, `sub`), each item's topic and the related pairs with 1-2 word labels
   - **no summary lines**. The answer is validated with zod (the schema comes
   from the same zod definition), kept in `api.state` and used for exactly the
   items it was made for; a restart does not ask again. Nothing is grouped
   without the model. The map is drawn as soon as this call answers.
3. **The summary-line calls** (`liner.ts`, `lines.ts`). The two short lines under
   each circle are asked for apart, in batches of at most 20 items (a batch
   names its items `i1`...`i20` and gets two lines of at most 22 characters
   back). Each item's lines are kept in `api.state` with a fingerprint of what
   they were made from (title, brief lines, conversation name, subject and
   head); only items with no lines yet, or whose fingerprint changed, go in a
   batch. Batches run one after another, at most one per page ask (so 75 items
   take 4 asks of the page, about 20 s), and only once the grouping is drawn. A
   failed batch (a refusal, a throw, an unreadable answer) stops the batches
   for a minute; the map is not affected. Until an item has lines it is drawn
   with its title only, and when its text changes its old lines stay until the
   new ones come.

**Why two kinds of call.** The fast tier has a 60 s timeout, and prifly allows
one ask in flight per extension and 60 an hour. One call that returned the
topics, two lines for each of ~75 items and the related pairs ran past 60 s on
Claude's fast tier every time, so no map ever appeared. Grouping alone is a
small answer (topics, an id per item, a few pairs); the lines are many small
answers that can fail or wait without costing the map. A first load of ~75
items is 1 grouping call and about 4 line batches; later refreshes normally
need none or one. The grouping and the batches share one limit (`limits.ts`):
never two asks at once, and no batch once 40 asks have been made in the last
hour, so the grouping and its retry always have room.

The prompts carry rules for the names and lines, and `rules.ts` checks them
after parsing. A theme name is bad when it shares its main word (any subject
word of three letters or more, leaving out filler such as "project" or
"support") with another theme's name, or is a catch-all ("Mixed", "Misc",
"Other", "General", "Various", "Activity", "Personal and Work"). A bad name, or
a grouping that leaves an item without a topic, sends the grouping call back
once with the reasons. If a bad name remains, the topic keeps its last good name
(with no earlier name, an overlap is kept and a catch-all makes the answer
unusable). A summary line is bad when it equals, starts, or sits inside its
item's title (case and punctuation ignored), or is generic ("Person contact",
"Message from"): it is left out, so the circle shows none rather than a repeat
of its title.

## The model

**No key is needed.** The extension asks prifly for a model through
`api.llm.ask` (prifly's feature `llm-ask`); prifly picks the model and the
backend (Claude, Codex or a provider the reader set up) and applies its own
limits. The manifest asks for the `fast` tier only, with the reason prifly shows
the reader: "Groups your sessions, chats, mails and cards into topics and names
them." The footer says which model answered: "Topics by claude-haiku via
Claude". The published `@prifly/extension-api` does not have `api.llm` yet, so
its types are in `llm.ts`, all optional.

A map is _good_ only when the model's answer is for the items on it now, and
the last good map is kept in `api.state`, so a restart still shows it. What the
reader sees when prifly has no model for the map:

- **Before there has been a good map**: `api/map` answers an error state and the
  panel shows an error page in place of the map. On a prifly without the
  `llm-ask` feature it says "This prifly cannot lend the map a model yet: update
  prifly." When prifly answers `no-model`, `not-allowed`, `capped` or `failed`,
  the page shows prifly's own one-sentence reason (for instance that no model is
  set up yet). An answer that stays unusable after the one retry says so. The
  page keeps asking, the extension tries again once a minute (also after a
  failure), and the map appears on its own once the model answers.
- **After a good map**: the same reasons leave the last good map on screen as it
  was (positions, themes, names), with the reason in the footer and when the map
  was last updated ("Last updated 14:32"). A change in the items, such as a new
  session, shows once the model has grouped it; until then the last good map
  stays. A failing summary-line batch is not an error of the map: it shows
  without those lines and the batch is tried again after a minute.

## The layout

Everything is laid out in the extension (`layout.ts`, `curves.ts`, `view.ts`)
with `d3-force`, seeded from the last positions so circles do not jump; the page
(`panel/`) only draws SVG and eases each circle and label to its new place. Themes
are fixed on an ellipse (rx 500, ry 270) round the centre of a 1680x1060 frame,
ordered so linked themes sit next to each other. Link labels go at the first
point of their curve no circle and no other label covers, bending the curve
further, and shortening the label, until one is free.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run check
```

The panel is plain JavaScript and CSS with no build step.

## License

[FSL-1.1-ALv2](LICENSE.md). Contributions need the [CLA](CLA.md).
