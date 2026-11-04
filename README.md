# Mind map for prifly

A live, self-updating radial mind map of your prifly sessions, the conversations
they are about and their Trello cards. Click **Mind map** in prifly's status bar
and it opens over nearly the whole window.

- **All sessions** sits in the middle. Around it, on an ellipse, are the
  **themes**: your own **areas** (Settings, below), in your order, or - with no
  areas set - 6 to 9 themes the model makes up. Either way a theme is what the
  work is about, whatever service it came from: a session, the WhatsApp chat and
  the mail about the same person or product sit together. Each session,
  conversation and card hangs off its theme, with its title in bold and two
  short summary lines; inside an area, two or more items on the same
  **sub-topic** hang off a small hub of their own.
- A dot on each session's rim says how it stands: green running, amber waiting
  on you, red error. (Idle and snoozed sessions are not drawn at all.)
- **Solid arrows** are links prifly knows: a session _started_ another, a
  session _waits on_ another, a card is a session's _ticket_. **Dashed curves**
  with an italic label join items about the same thing, labelled by what they
  share: the person's first name, the repository, the ticket id - or, for a
  pair only the model sees, its 1-2 words.
- Conversations and cards are smaller circles, ringed in their service's
  colour. A legend runs along the bottom; the footer says which model made the
  topics ("Topics by claude-haiku via Claude") and which sources could not be
  read.

## Opening a circle

A left-click does the first line of the circle's menu; a right-click shows the
whole menu, with the service named on every line. The menu closes on Escape, a
click outside or a choice, and stays inside the window.

- **A session** opens in prifly ("Open in prifly"). Below that the menu lists
  what it is linked to, each as "Open <title> in <service>": its Trello card (the
  card's `sessionId`) and the conversations it has a related or ticket link to.
- **A card or a conversation** opens in the reader's own browser: "Open in
  Trello", "Open in Gmail", "Open in WhatsApp", "Open in Outlook", "Open in
  Instagram", "Open in LinkedIn", "Open in Messenger", when the item has a link.
  An item with nowhere to open shows one greyed line, "Nothing to open".

Links go to the operating system's browser through `api.openUrl` (prifly's
feature "open-url"), never `window.open`, which inside prifly's window is not
your browser. The page asks `api/open` with an item id and the id of the item
to open; the extension looks that item's link up itself and refuses an unknown
item or a target the item's menu does not list, so the page cannot open an
arbitrary URL. On a prifly without "open-url", or when it answers false, the
panel says "prifly could not open the browser".

The links:

- Gmail: `https://mail.google.com/mail/u/0/#all/<thread_id>`, or
  `https://mail.google.com/mail/?authuser=<email>#all/<thread_id>` when the read
  was for a named account.
- Trello and the other services: the link their tool gave.
- WhatsApp: only a real phone id (`<digits>@s.whatsapp.net` or `@c.us`) gets a
  phone link, `https://wa.me/<number>` (`46701234567@s.whatsapp.net` gives
  `46701234567`), which the browser hands to the installed WhatsApp app. Every
  other chat is `https://web.whatsapp.com/`: a person's `@lid` id is WhatsApp's
  internal linked id, not a phone number, and a group (`@g.us`) has no deep
  link. A link is never built from the digits of such an id.

Without prifly's feature "open-url-apps", `openUrl` accepts only http and
https, and the links above are what opens. With it, "Open in WhatsApp" and "Open
in Trello" open the desktop apps (`appLinkOf` in `opening.ts`):

- WhatsApp chat with a real phone id: `whatsapp://send?phone=<number>`.
- Every other WhatsApp chat (`@lid`, `@g.us`): `whatsapp://`, the app itself.
- Trello card: `trello://x-callback-url/showCard?shortlink=<shortlink>`, the
  form Atlassian documents for its URL scheme; the shortlink is taken from the
  card url `https://trello.com/c/<shortlink>/...`.

When `openUrl` answers false for the app link (no app registered for the
scheme), the web link is opened at once instead. Gmail, Outlook and the other
services stay web links.

The map never sends a message, marks anything read or changes the mailbox.

## Your areas

Settings → Extensions → Mind map has one setting, **Areas**: the map's
top-level themes, in your order. Each area is a name, optionally followed by
":" and a few words of hint for the model. prifly's settings field is a single
line, so areas are separated by ";" (a newline works too). The default:

```text
ODI / Artemis product; Partners & integrations: Teamtailor, Jobylon, Intelliplan, Eltel; prifly: prifly and its extensions; Proxy & datamining; Finance: Fortnox, Pleo, bokföring, invoices; Family & friends
```

With areas set, the model only places (`placing.ts`): every item goes under
exactly one area, by what it is about and never by the service it came from,
with an optional sub-topic of 1-3 words inside it. It may not invent a
top-level theme; an answer that names something that is not one of your areas
puts the item under **Other**, which is on the map only while it holds
something. Every area keeps its place on the ellipse and its colour (the
colour of its place in the list; Other is grey), even with nothing in it. An
edit of the setting regroups the map at once (`api.onSettings`). An empty
setting, or a prifly without settings, keeps the model's own themes, as before
there were areas.

**Move to theme…** in a circle's right-click menu lists the areas with their
sub-topics now, a tick on where the circle is. A choice moves it at once: the
page posts `api/move` with the item id, the area and the sub-topic, the
extension keeps the move in `api.state` (`placements`, keyed by item id) and
answers the new map. The model never overrides a move, across regroups and
restarts, and the latest 30 moves go along in the placing call as examples
("the reader put "Teamtailor webhook" under Partners & integrations /
Teamtailor"), so similar new items follow. A moved circle's menu also has
**Reset placement**, which gives it back to the model. A move to an area you
later remove is kept but not used. Without areas the menu has neither line.

## How it stays current

The page asks for the map every 5 s while it is visible, and not at all while it
is hidden; nothing is read for a closed map. Each ask starts what is due:

| What                                                                                                        | How often                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Sessions (`api.sessions()`)                                                                                 | every 15 s, so a new session shows within 15 s                                     |
| WhatsApp, Gmail (`is:starred OR (is:unread in:inbox)`), Outlook (received in the last 3 days), Trello cards | every 5 min                                                                        |
| Instagram, LinkedIn, Messenger (they drive your browser)                                                    | every 15 min                                                                       |
| Grouping and naming (`api.llm.ask`, the fast tier)                                                          | one call when the items changed, at most once a minute                             |
| Summary lines (`api.llm.ask`, the fast tier)                                                                | batches of 20, only for items whose text is new or changed, one batch per page ask |

Each source is one listing call through `api.tools.read` - never a loop over
threads, and nothing is marked read. A missing or failing source is skipped and
named in the footer. The map shows only what matters now, so most of what the
tools list is left out:

- **Sessions**: only running (working, starting, agents, background), waiting
  on you (waiting, or asking you) and error. Idle, snoozed (a `snoozedUntil` in
  the future, even on an error), ended and archived sessions, agent reports and
  prifly's summariser folds are not drawn. At most 40 sessions.
- **Gmail**: starred threads and unread threads in the inbox (one
  `gmail_search`, max 30), whatever their age.
- **WhatsApp**: only chats with someone else that had a message in the last 3
  days. The listing does not mark the reader's own chat, so the reader's name is
  taken from the most frequent sender on their sent Gmail threads (one
  `gmail_search` for `in:sent`, once a day) and a chat of that name is left out.
  Without Gmail nothing is left out as the reader's own chat.
- **WhatsApp** also leaves out a chat with no name: an empty name, one made
  only of digits, plus signs and spaces, or one equal to the chat's id.
- **Trello**: a card in a done column (a name that is done, klar, klart, färdig
  or avslutad, any case) is never shown, whether a session carries it or not.
  Kept, in this order: cards in an in-progress column (a name containing
  progress, doing, pågår, working, in work, wip or active, any case; those a
  session carries first), then cards in "Denna Vecka" (or "This week"), then
  cards in any other column that a session carries (`sessionId`), such as
  "Avvaktar" or "Denna Månad". Cards with no session in those other columns
  stay out. At most 15.
- **Outlook, Instagram, LinkedIn, Messenger**: as listed, kept when they match
  a session or had a message in the last 3 days. At most 20 conversations in
  all, Gmail first, then the best session matches.
- **Telegram** is not read.

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
     without the model. The map is drawn as soon as this call answers. With
     areas set, the same call places instead (see "Your areas"): it is sent the
     areas and their hints, the previous sub-topics with their members and your
     moves as examples, and answers each item's area and sub-topic; the areas
     are part of what it was made for, so a changed setting asks again.
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

With areas, the naming checks are on the sub-topics: one that is a catch-all, a
service's name (WhatsApp, Gmail, Trello...) or only its area's name sends the
call back once with the reasons, and if it comes back again it is dropped (the
item stays in its area, with no sub-topic). An item the answer leaves out is a
reason to ask again too, and goes under Other if it stays out.

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
  was last updated ("Last updated 14:32"). The grouping depends only on which
  items there are and their titles and subjects, so a change of status, brief or
  last message re-renders at once with the grouping that stands (the summary
  lines are the liner's job). An item the answer does not know yet is left off
  until the model has grouped it; the rest is drawn from the existing answer.
  Only when there is no answer at all is the saved map shown, and then without
  every circle and link whose item is no longer on the map: the map never shows
  an item that is not in the current reads. A failing summary-line batch is not an error of the map: it shows
  without those lines and the batch is tried again after a minute.

## The layout

Everything is laid out in the extension (`layout.ts`, `curves.ts`, `view.ts`)
with `d3-force`, seeded from the last positions so circles do not jump; the page
(`panel/`) only draws SVG and eases each circle and label to its new place. Themes
are fixed on an ellipse (rx 500, ry 270) round the centre of a 1680x1060 frame,
ordered so linked themes sit next to each other (your areas keep your order). A
sub-topic hub is a small circle in its area's branch with its members a ring
further out; it takes part in the same collision and separation as every other
circle, so it never overlaps one. Link labels go at the first
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
