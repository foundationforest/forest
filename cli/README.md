# cli

Up: [the repo](../README.md).

## What it is

`forest`: one small program that does Forest actions, given a profile's address and an access key.
It has two doors on the same code:
- typed commands, for people, scripts and agents that run commands;
- MCP tools (`forest mcp`), for AI chats.

It stores nothing. Every call carries the key it needs, or the copy was started with it.

It reads folders from hosts with [records/](../records/README.md)' library, and checks every
signature itself. It reads markets and scores from an index. It writes and sends only with access
keys, never a main key, and it moves no money. An AI with only a message key can ask for anything
and do nothing alone.

## How it works

### Two doors

- **Typed commands.** `forest <action> [<argument>] [--name value …]`. Objects are given as JSON.
  Every answer is JSON. A refusal is one line, with exit status 1. `forest help` shows how Forest
  works, then every action and the key it needs.
- **MCP tools.** Every action is also a tool.
  - `forest mcp` serves the tools over stdio, for an AI app on the same device.
  - `forest mcp --http [hostname:]port` serves them over Streamable HTTP at `/mcp`, for a hosted
    copy. It listens on 127.0.0.1 unless told otherwise; TLS is the operator's.
  - The AI first gets a short text on how Forest works: the server's instructions.
  - Each tool says what it does and which key it needs.

Both doors read one file, `src/actions.ts`. It holds that text, and each action's words, key and
parameters.

### The actions and their keys

| Action | Key | What it does |
|---|---|---|
| `market <market>` | none | What an index says of a market |
| `profile <address>` | none | A profile's card, its offers and the reviews it wrote, from its hosts, every signature checked; and, if an index is set, that index's summary of it, such as its scores |
| `private` | read | The profile's private records this read key opens |
| `inbox` | message; read to open | The messages to the profile, from each of its hosts; each one opened if the read key is one of the inbox's readers |
| `post-offer`, `update-offer <id>`, `remove-offer <id>` | write | An offer at `offer/<id>` |
| `post-review` | write | A review at `review/<id>` |
| `send <to>` | message | A message to another profile's inbox |
| `request <action>` | message | Ask for one of the actions above, or `pay`, through the profile's own inbox (below) |

A key is written as a grant writes it ([records](../records/README.md#grants)): for a write or
message key, its 32 private bytes in base64url; for a read key, its age identity.

Before it signs anything, it checks the key against the profile's permissions record, and refuses
in plain words:
- No key: `no key for this; use request`.
- A key that is not listed, is listed with another scope, or whose paths don't cover the path.
- The profile's main key, or its inbox key. Only access keys are taken
  ([keys](../keys/README.md#rules-for-apps-that-hold-keys), rule 3).
- A path the owner wrote. The owner wins, so only the owner's app can change it.
- An offer or a review that does not fit its shape ([schemas/](../records/schemas/)).
  `createdAt` is set if it is missing.

### Request

The one way to have something done that no key here allows. `request` names one of the actions
above that need a key, or `pay`, and carries that action's parameters. It sends them to the
profile's own inbox as `{ "request": <action>, … }` ([records](../records/README.md#inbox),
Requests):
- `{ "request": "post-offer", "offer": { … } }`
- `{ "request": "send", "to": <address>, "text": … }`
- `{ "request": "pay", "offer": <pay link> }`

Typed: `forest request post-offer --params '{"offer": {…}}'`. Over MCP: `action` and `params`. The
parameters are checked against that action's own, so a request never carries a key. The person's
app shows it, and does it with the main key, or not.

`inbox` marks a message `"request": <action>` only when the profile sent it to itself, by its main
key or by a message key its permissions record lists, and its parameters fit that action. Any other
`request` body, such as a stranger's, shows as a plain message.

### Settings

| Flag | Variable | What it sets |
|---|---|---|
| `--host <origin>` | `FOREST_HOSTS`, comma separated | The hosts to start from. Without one: the hosts the foundation's index reads, from its public list ([`index/lists/hosts.json`](https://github.com/foundationforest/services/blob/main/index/lists/hosts.json) in services), read once per run |
| `--index <url>` | `FOREST_INDEX` | The index for markets and scores. No default. For example, the foundation's devnet index is `https://index-production-1b6e.up.railway.app`; that address will change |
| `--profile <address>` | `FOREST_PROFILE` | The profile acted for |
| | `FOREST_WRITE_KEY`, `FOREST_MESSAGE_KEY`, `FOREST_READ_KEY` | The keys. They come from the environment only, because a flag shows in the process list and in the shell's history |

Over MCP, each tool also takes `profile` and its keys in the call (`writeKey`, `messageKey`,
`readKey`). A key in the call wins over one from the start.

### Hosts and the index

A folder is always read from hosts, never from an index:
- The CLI reads the profile on each start host, then on every host its hosts record names. Records'
  `readProfile` checks every record.
- Writes and messages go to the hosts that the hosts record names.
- A profile with no records on any start host is out of reach until one of its hosts is added with
  `--host`.

An index is read for two things only, `GET <index>/markets/<market>.json` and
`GET <index>/profiles/<address>.json`. Both are passed on as that index's word. This JSON is the
foundation's index's own format, not part of the standard: it carries no signatures, and other
indexes may differ.

### Running it yourself, or a hosted copy

- **Run it yourself to keep your keys off anyone's server.** Started with keys in its environment,
  `forest mcp` uses them whenever a call carries none, so the AI never sees them. They stay in
  memory while it runs, and are never written.
- **A hosted copy (`forest mcp --http`) sees each key while it acts, and keeps nothing.** Each
  request gets a fresh server, with no session, and nothing is written.
  - It takes keys only in the call, and refuses to start with one in its environment. Otherwise
    every caller would act as that person.
  - A key in a call is written by the AI, so the AI's maker sees it too.

Privacy: run the model on your own device and nothing of yours leaves it; in any cloud, you depend
on that company's promises.

### Run it

```
(cd keys && npm ci)        # the tests take their keys from keys/
(cd records && npm ci)     # the CLI runs on records' library
cd cli
npm ci
npm run check              # type-check
npm test                   # every action against records' reference host on loopback, and both doors
node src/main.ts help
```

Node 22.18 or later. Built from existing pieces, used unchanged:
- records' library;
- `@modelcontextprotocol/sdk`, for the MCP door;
- `ajv` and `ajv-formats`, for the record shapes;
- `age-encryption`, to work out a read key's public half.

## Promises

- **It keeps nothing.** No key, record or message is written anywhere, and each call reads again
  what it needs. The only thing it holds between calls is the public list of hosts to start from.
- **Never a main key.** It refuses a profile's main key and its inbox key. It acts only with
  access keys, within the scopes and paths the permissions record lists.
- **It checks what it reads from hosts.** Records' library checks every record and message from a
  host, signature included. What an index says is passed on as the index's word, and labelled so.
- **It moves no money.** There is no pay action. Paying is a request, answered by the person's own
  app.

## Limits

- **A hosted copy sees each key while it acts.** It keeps none, but you trust its operator while it
  acts. The AI's maker also sees every key the AI writes into a call.
- **Profiles off the start hosts are out of reach.** A profile that no start host holds can't be
  read, written to or sent to until its host is added.
- **What an index says goes unchecked.** It carries no signatures. The CLI can't tell whether an
  index is honest; it only passes on what the index says.
- **Not here:**
  - paying;
  - blobs (photos and videos);
  - handing out keys: a message carrying a grant is refused;
  - reviews others wrote about a profile, except through an index's summary.
- **Slow.** On every call it reads the whole folder from every start host, and checks signatures in
  JavaScript ([records](../records/README.md#limits)).

## Who decides what

- **The standard:** only the request body, which [records](../records/README.md#inbox) holds.
- **Whoever runs a copy:** the hosts it starts from, the index it reads, and, for a copy run at
  home, the keys it starts with.
- **The person, through their app:** which access keys to hand out, with which scopes and paths, and
  what to do with each request.
- **An index, by its own policy:** what its markets and scores say.

## FAQ

**Why is there no pay action?**
With only an allowance, a program can't open an escrow in the person's name: the buyer signs
`create`. It could pay into the deposit address of an escrow nobody has opened yet. But opening
that escrow needs its terms, a random id among them, and if those were lost the money would wait
there for good. So paying is a request: the person's app pays with the main key, as it does for
any deal. Pay keys stay in the standard for later.

**Why does it refuse the inbox key?**
The inbox key opens every message and grant sent to the profile, and grants hold keys. It is mixed
from the main key, and stays on the device with it. A read key opens only what is sealed to it.

**Can it read the reviews others wrote about a profile?**
Only through an index's summary. Those reviews sit in their writers' folders, and only an index
gathers them.
