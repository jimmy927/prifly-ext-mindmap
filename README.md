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
  pair only embeddings tie, the model's 1-2 words.
- Conversations and cards are smaller circles, ringed in their service's
  colour. A legend runs along the bottom; the footer says which models made
  the map and which sources could not be read.

Clicking a session opens it in prifly. Clicking a card opens it in Trello, and a
conversation opens its link when its tool gave one. The map never sends a
message or changes anything.

## How it stays current

The page asks for the map every 5 s while it is visible, and not at all while it
is hidden; nothing is read for a closed map. Each ask starts what is due:

| What                                                                                             | How often                                                              |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Sessions (`api.sessions()`)                                                                      | every 15 s, so a new session shows within 15 s                         |
| WhatsApp, Gmail (`newer_than:3d`), Outlook (received in the last 3 days), Telegram, Trello cards | every 5 min                                                            |
| Instagram, LinkedIn, Messenger (they drive your browser)                                         | every 15 min                                                           |
| Embeddings                                                                                       | for new or changed items only, one batched call, at most once a minute |
| Naming                                                                                           | one short call per new or changed theme, at most one round a minute    |

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

Themes are topic clusters, worked out in three steps:

1. **Shared entities, no model** (`entities.ts`). People (a chat's name, a mail's
   sender and address, a WhatsApp number), mail domains, repositories, card
   names, ticket-like ids (`SHOP-12`, `prifly-541`) and rarer words are read out
   of each item's title, brief lines, name, subject and last message. A person
   is also found by their first name in another item's text ("Reply to Ada").
   Two items that share one get a strong edge. A service's name is never an
   entity, and one on more than 4-6 items (the reader's own name, a surname, a
   word every mail has) ties nothing.
2. **Embeddings** (`embed.ts`). Each item's own words - never its service - go to
   `google/embeddinggemma-300m` on DeepInfra's OpenAI-compatible embeddings
   endpoint (multilingual, Swedish and English). Vectors are cut to 256
   dimensions and cached in `api.state` by a hash of the text. A pair above
   cosine 0.84 gets a weak edge (EmbeddingGemma's cosines run high: on 87 real
   texts the median pair was 0.75, the top 1 % above 0.90).
3. **Clustering** (`cluster.ts`). Louvain community detection on the weighted
   graph, written here and deterministic, gives 6 to 9 topics. Each item starts
   in its last topic and is a little sticky there, so one new item does not
   reshuffle the map, and a topic keeps its id while most of its members stay.
   An item with no edge joins the nearest topic by embedding, or its
   repository's.

The model only names: `google/gemma-4-26B-A4B-it` on DeepInfra gets one short
call per new or changed topic, with its members' titles, brief lines, subjects
and the start of the last message, and answers the theme's name, a line under
it, two summary lines per member and labels for the pairs only embeddings tie.
The answer is checked with zod and kept in `api.state`; a topic keeps its name
while its members barely change. Measured on 28 real sessions and 60 listed chats and
mails, a first refresh (87 distinct texts embedded, 48 items drawn, 6 topics named in parallel) took
about 6 s and cost about $0.0006; later refreshes send only what changed.

It needs a DeepInfra key in prifly's vault: an `api-token` entry named
`deepinfra` (or `deepinfra-api`) at level 1, the one level an extension can read.
Nothing is grouped or named without DeepInfra: shared entities only add edges to
the clustering, together with the embeddings. A map is _good_ only when the
embeddings and the names exist for the items on it now, and the last good map is
kept in `api.state`, so a restart still shows it.

- **Before there has been a good map** (no key in the vault, a failed embedding
  call, a failed naming call): `api/map` answers an error state and the panel
  shows an error page in place of the map. It says why: "No DeepInfra key in the
  vault (an api-token entry named deepinfra or deepinfra-api, at level 1)", or
  DeepInfra's HTTP status and short message. The page keeps asking, the
  extension tries DeepInfra again once a minute, and the map appears on its own
  once the calls succeed.
- **After a good map**: a failing call, or a missing key, leaves the last good
  map on screen as it was (positions, themes, names), with the error in the
  footer and when the map was last updated ("Last updated 14:32"). A change in
  the items, such as a new session, shows once its embedding and name have
  arrived; until then the last good map stays.

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
