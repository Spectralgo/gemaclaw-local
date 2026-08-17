# GemaClaw Local

Run **GemaClaw** — [Gema](https://gema.spectralgo.com)'s household deep-task agent — on your own computer, powered by **your own AI subscription**. No API key, no extra inference bill: the agent loop runs locally on your Claude Code or Codex/ChatGPT login, while every read and every (approval-gated) write still flows through Gema's capability broker.

A fork of [raroque/boop-agent](https://github.com/raroque/boop-agent) (MIT) — boop's subscription runtime adapters are the engine here; the iMessage/Convex/Composio layers were removed and replaced with Gema's task transport and tool surface.

```
Gema chat: "@Gema deep: plan three dinners from our list"
     │  approval card → a household member approves
     ▼
Gema server ──(poll/claim, companion token)──► this companion, on your Mac
     ▲                                              │
     └──(lease-gated broker: reads, chat posts, ────┘
         approval-gated proposals, completion)
              brain: YOUR Claude/Codex subscription
```

## Talk to Gema from your messenger

- **Telegram (recommended)**: a dedicated bot — every DM is an ask, `deep:` files tasks. No webhook, long-polling only.
- **WhatsApp**: link your own account (QR); `@gema …` in your self-chat, allowlisted numbers welcome.

Both run the same four abilities on your subscription: grounded answers, approval-gated grocery proposals, household-chat notes, and deep-task filing. See the [tutorial](TUTORIAL.md).

## Why

- **Smarter deep tasks** — your subscription's frontier model instead of the hosted default brain.
- **Your data stays governed** — the companion has exactly the sandbox contract: broad reads, narrow approval-gated writes, no deletes, a hard per-task call budget, and a kill switch in the household settings. The model runs locally, but it can't do anything a hosted GemaClaw couldn't.
- **Your credential never leaves** — the Claude/Codex login stays on your machine; only tool traffic crosses the wire.

**New here? The [complete illustrated tutorial](TUTORIAL.md) walks through everything — pairing, deep tasks, Telegram, and WhatsApp.**

## Setup

Prereqs: Node 20+, one agent runtime signed in (`npm i -g @anthropic-ai/claude-code` then `claude`, or `npm i -g @openai/codex` then `codex login`), and **GemaClaw Local enabled on your Gema server** (`GEMA_LOCAL_BRAIN=true`).

```bash
git clone https://github.com/Spectralgo/gemaclaw-local
cd gemaclaw-local
npm install

# In the Gema app: Settings → GemaClaw Local → "Pair a computer" (household owner)
npm run setup   # server URL + the 8-char pairing code + runtime + channels
npm run doctor  # optional health check — verifies every link in the chain
npm start       # the companion polls for approved deep tasks
```

Then in Gema chat: `@Gema deep: plan three dinners from our list`. Approve the card, watch the companion pick it up, and Gema's plan lands back in chat.

If the companion is offline when a task is approved, the task simply runs in Gema's hosted sandbox instead — pairing never takes capability away.

## Desktop app (macOS)

Prefer not to keep a terminal open? The same companion ships as a **menu-bar app**: pair from a window, and the poller runs quietly in the background with its status one click away.

```bash
npm run desktop:dev    # run the app from this checkout
npm run desktop:pack   # build an unsigned GemaClaw Local.app in dist/mac-arm64
npm run desktop:dist   # build a distributable zip
```

- The tray shows the live state — *not paired · watching for deep tasks · running a task · reconnecting* — with Start/Stop/Restart, Launch at Login, and a status window with the pairing form and a live log tail.
- The app and the CLI are interchangeable: both read `~/.gemaclaw` (config + WhatsApp session), so you can pair in the app and later run `npm start` in a terminal, or vice versa. Closing the window just hides it; quit from the tray.
- Stopping (or quitting) sends the same SIGINT drain as Ctrl-C in the terminal — a claimed task is left to the server watchdog, exactly like the CLI.
- Non-interactive pairing is also available headless: `npm run pair -- --server <url> --code <8-chars> [--runtime claude|codex]`.
- End-to-end check without a real server: `node scripts/stub-gema-server.mjs &` then `node scripts/desktop-e2e.mjs <shots-dir>` (drives the app UI with Playwright against the stub).

The bundle is unsigned (right-click → Open on first launch). The app never bundles secrets — everything mutable stays in `~/.gemaclaw`.

## How it works

| Piece | File | Job |
|---|---|---|
| Poller | `server/main.ts` | Poll `/gemaclaw/companion/poll` (heartbeat), claim one task at a time |
| Task runner | `server/task-runner.ts` | Fetch context, build the system prompt, drive the runtime, always report completion |
| Gema tools | `server/gema/tools.ts` | The sandbox's 11 tools as native SDK tools, backed by the lease-gated broker |
| Transport | `server/gema/client.ts` | pair / poll / claim + broker calls (`x-gemaclaw-lease`) |
| Runtimes | `server/runtimes/` | boop's Claude Agent SDK + Codex app-server adapters, unchanged |
| Config | `server/config.ts` | `~/.gemaclaw/config.json` (0600) — server URL, companion token, runtime, model |

Per-task JSONL logs land in `~/.gemaclaw/logs/`.

## Security model

- Pairing = one-time 8-char code (10-min TTL) generated by the household **owner** in Gema's settings, exchanged for a long-lived token stored hashed server-side. Revoke any time from the same screen.
- The companion token grants only *poll* and *claim*. Executing a task uses a per-task lease that dies the moment the task leaves "approved", with a 40-call budget.
- List/expense writes don't exist; item proposals become approval cards a human must accept.
- The local runtime is sandboxed to the Gema tools plus WebSearch/WebFetch — no shell, no filesystem.

## Development

```bash
npm run typecheck
npm test
npm run dev   # tsx watch server/main.ts
```

MIT, like the upstream template it forked from.
