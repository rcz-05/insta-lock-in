# Insta Lock In

Keeps Instagram locked on my iPhone until one specific person posts, shares a story, or messages me. When she does, Instagram opens for a short, capped session, I get nagged until I confirm a checklist, then it locks again.

Everything is free: an iOS Shortcuts gate, a Cloudflare Worker that holds the lock state, Bark for push reminders, and a Playwright checker on my Mac.

```
Instagram ──reads──> Mac checker ──POST /unlock──> Cloudflare Worker (state in KV)
                                                        │
                              status, nags, done        │
             ┌──────────────────────┬───────────────────┴───────┐
        Shortcuts gate          Bark app                 Checklist page
   (on open: GET /status,   (nags every 5 to 10 min)  (tick items, POST /done)
    locked: go Home)
```

## Cycle

| State | Meaning | Leaves when |
| --- | --- | --- |
| `locked` | Default. The gate sends you to the Home Screen. | The Mac checker sees a new post, story or message from her |
| `unlocked` | Something new is waiting. No clock running yet. | You open Instagram (first `GET /status`) |
| `session` | Clock running, nags firing. | Checklist complete, or the time cap is hit |

## Progress

- [x] Step 1: Worker and state (`/status`, `/unlock`, `/done`, `/state`), deployed to Cloudflare
- [x] Step 2: Bark pushes and the cron nag loop
- [x] Step 3: Shortcuts gate on the iPhone
- [x] Step 4: Checklist page
- [x] Step 5: Mac checker (Playwright)
- [x] Step 6: launchd schedule
- [x] Step 7: Hardening
- [ ] Step 8: Full cycle test

## Layout

```
worker/
  src/logic.js     pure state machine (no I/O), fully unit tested
  src/index.js     HTTP routes, auth, KV storage, pushes, cron
  src/checklist.js checklist page HTML
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
| POST | `/unlock` | Mac checker | Body `{ reason: "post", "story" or "dm", items: [{ id, url?, from? }] }`. Ignores ids it has seen before. Sends an "Instagram unlocked" push. |
| POST | `/done` | Checklist page | Body `{ checked: ["view", "like"] }`. Relocks once every required action is ticked. |
| GET | `/checklist` | You, from a reminder | Page with the items and a checkbox per action. Done posts `/done`. Viewing it never starts the clock. |
| GET | `/state` | You, for debugging | Full state record. |
| POST | `/lock` | You, for emergencies | Forces the state back to locked. |

The full plan is in `docs/PLAN.md`. Context for Claude Code sessions is in `CLAUDE.md`.
