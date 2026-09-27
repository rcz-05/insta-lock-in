# Insta Lock In

Keeps Instagram locked on my iPhone until one specific person posts or sends me Reels. When she does, Instagram opens for a short, capped session, I get nagged until I confirm a checklist, then it locks again.

Everything is free: an iOS Shortcuts gate, a Cloudflare Worker that holds the lock state, ntfy for push reminders, and a Playwright checker on my Mac.

```
Instagram ──reads──> Mac checker ──POST /unlock──> Cloudflare Worker (state in KV)
                                                        │
                              status, nags, done        │
             ┌──────────────────────┬───────────────────┴───────┐
        Shortcuts gate          ntfy app                 Checklist page
   (on open: GET /status,   (nags every 2 to 5 min)   (tick items, POST /done)
    locked: go Home)
```

## Cycle

| State | Meaning | Leaves when |
| --- | --- | --- |
| `locked` | Default. The gate sends you to the Home Screen. | The Mac checker sees a new post or new Reels from her |
| `unlocked` | Something new is waiting. No clock running yet. | You open Instagram (first `GET /status`) |
| `session` | Clock running, nags firing. | Checklist complete, or the time cap is hit |

## Progress

- [x] Step 1: Worker and state (`/status`, `/unlock`, `/done`, `/state`), deployed to Cloudflare
- [x] Step 2: ntfy pushes and the cron nag loop
- [ ] Step 3: Shortcuts gate on the iPhone
- [ ] Step 4: Checklist page
- [ ] Step 5: Mac checker (Playwright)
- [ ] Step 6: launchd schedule
- [ ] Step 7: Hardening
- [ ] Step 8: Full cycle test

## Layout

```
worker/
  src/logic.js     pure state machine (no I/O), fully unit tested
  src/index.js     HTTP routes, auth, KV storage
  test/            node:test suites
  wrangler.toml    Worker config (caps, required actions)
```

## Run the tests

```
cd worker
npm test
```

## API

All requests need the shared secret, either as header `X-Token: <token>` or query `?t=<token>`.

| Method | Path | Called by | Does |
| --- | --- | --- | --- |
| GET | `/status` | Shortcuts gate | Returns `{ open, state, message, minutes_left }`. First call after an unlock starts the session clock. |
| POST | `/unlock` | Mac checker | Body `{ reason: "post" or "reels", items: [{ id, url? }] }`. Ignores ids it has seen before. |
| POST | `/done` | Checklist page | Body `{ checked: ["view", "like"] }`. Relocks once every required action is ticked. |
| GET | `/state` | You, for debugging | Full state record. |
| POST | `/lock` | You, for emergencies | Forces the state back to locked. |

The full plan is in `docs/PLAN.md`. Context for Claude Code sessions is in `CLAUDE.md`.
