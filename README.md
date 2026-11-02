# Mind map for prifly

A live, self-updating radial mind map of your prifly sessions, the conversations
they are about and their Trello cards. Click **Mind map** in prifly's status bar
and it opens over nearly the whole window.

- **All sessions** sits in the middle. Around it, on an ellipse, are 6 to 9
  **themes**: what the work is about. Each session, conversation and card hangs
  off its theme, with its title in bold and two short summary lines.
- A dot on each session's rim says how it stands: green running, amber waiting
  on you, red error, grey idle or snoozed.
- **Solid arrows** are links prifly knows: a session _started_ another, a
  session _waits on_ another, a card is a session's _ticket_. **Dashed curves**
  with an italic label are links the model sees between items about the same
  thing.
- Conversations and cards are smaller circles, ringed in their service's
  colour. A legend runs along the bottom; the footer says how the themes were
  made and which sources could not be read.

Clicking a session opens it in prifly. Clicking a card opens it in Trello, and a
conversation opens its link when its tool gave one. The map never sends a
message or changes anything.

## How it stays current

The page asks for the map every 5 s while it is visible, and not at all while it
is hidden; nothing is read for a closed map. Each ask starts what is due:

| What                                                                                             | How often                                                                        |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Sessions (`api.sessions()`)                                                                      | every 15 s, so a new session shows within 15 s                                   |
| WhatsApp, Gmail (`newer_than:3d`), Outlook (received in the last 3 days), Telegram, Trello cards | every 5 min                                                                      |
| Instagram, LinkedIn, Messenger (they drive your browser)                                         | every 15 min                                                                     |
| The model                                                                                        | when the titles, brief lines or conversation heads change, at most once a minute |

Each source is one listing call through `api.tools.read` - never a loop over
threads, and nothing is marked read. A missing or failing source is skipped and
named in the footer. Up to 20 conversations are drawn - those a session is about
first, then any with a message in the last 3 days - and up to 15 cards, those
with a session first. Ended leftovers (untitled sessions, agent reports,
prifly's summariser folds) are left out, and at most 40 sessions are drawn.

Conversations and cards need prifly's `read-tools` feature, and the solid links
and brief summaries its `session-facts` feature. On a prifly without them the map
shows sessions only, themed by repository.

## The themes

A small instruct model on DeepInfra (`Qwen/Qwen2.5-7B-Instruct`) sorts the items
into themes, writes the summary lines and sees the related links. It is sent each
item's id, kind, title, repository and brief lines, and for a conversation the
name, subject and the first 200 characters of the last message - plus the last
themes, so they stay put. Its answer is checked with zod and kept in `api.state`.

It needs a DeepInfra key in prifly's vault: an `api-token` entry named
`deepinfra` (or `deepinfra-api`) at level 1, the one level an extension can read.
Without one - or before the model has answered - there is one theme per
repository, conversations under their service and cards under "Trello", with
summaries from the sessions' brief lines. When a call fails after an earlier
one succeeded, the last themes are kept rather than the map being reshuffled.

The model was chosen by measuring two candidates on 33 real session titles, three
runs each:

| Model                                 | Valid JSON                     | Time per sorting | Themes                                                                                |
| ------------------------------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| Qwen/Qwen2.5-7B-Instruct              | 3 of 3                         | 33-52 s          | named by what the work is (Disk space, Integrations, Emails); lines fit 22 characters |
| meta-llama/Meta-Llama-3.1-8B-Instruct | 2 of 3 (one timed out at 60 s) | 42-57 s          | generic ("Customer", "Person", "Tool"); most lines too long                           |

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
