# CLAUDE.md

Context for any Claude Code session working in this repo. Read this first, then `docs/PLAN.md` for the full architecture.

## What this is

Rayan's personal tool to keep Instagram locked on his iPhone until one specific person (her Instagram handle goes in config later, never in git) posts or sends him Reels. When she does, Instagram opens for a short capped session, he gets nagged by push notifications until he ticks a checklist (view, like, comment for posts; watched, replied for Reels), then it locks again. Goal: cut Instagram screen time hard, for free.

Planning happened in a Claude (Cowork) session on 2026-09-27. Decisions below are settled; do not relitigate them unless Rayan asks.

## Settled decisions

- Platform: iPhone. No paid Apple Developer account, so no Screen Time API. Everything is free.
- The lock is a gate on open, not deletion: an iOS Shortcuts automation ("Instagram is opened", Run Immediately) calls `GET /status` and runs Go to Home Screen when locked.
- State lives in a Cloudflare Worker with KV. Single JSON record, key `state`.
- Push reminders go through ntfy (ntfy.sh, free iOS app), sent by a Worker cron that runs every minute.
- Detection runs on the MacBook: Playwright with a saved Instagram session, checking her profile and the DM thread with her every 20 minutes via launchd. Slow, home network only, never from a cloud server. Fallback: paste her post link.
- Time cap per session: posts 15 min; Reels 10 min plus 1 per Reel. The clock starts on first open after an unlock. The cap relocks even if the checklist is ignored.
- Items that already unlocked once never unlock again (`seen` list, capped at 200).

## Status

| Step | State |
| --- | --- |
| 1. Worker and state (`/status`, `/unlock`, `/done`, `/lock`, `/state`) | Done, 24 tests passing, not deployed yet |
| 2. ntfy pushes and cron nag loop | Next |
| 3. Shortcuts gate on iPhone | Todo (Rayan does it on the phone; give exact steps) |
| 4. Checklist page (`GET /checklist`) | Todo |
| 5. Mac checker (Playwright) | Todo; needs her handle and the DM thread URL from Rayan |
| 6. launchd schedule | Todo |
| 7. Hardening (heartbeat, Screen Time web block) | Todo |
| 8. Full cycle test | Todo |

## Infra facts

- Cloudflare account id: `f5c3178b0fbde14313e6eefc984feaaf`.
- KV namespace `insta-lock-in-LOCK_KV` already exists, id `81eb575709fc4ea9b56b9aa702efd710`, already set in `worker/wrangler.toml`.
- Worker not deployed yet. To deploy from `worker/`: `npm install`, `npx wrangler login`, `npx wrangler deploy`, then set the secret with `mkdir -p ../.secrets && openssl rand -hex 24 > ../.secrets/token && npx wrangler secret put TOKEN < ../.secrets/token`.
- Without the `TOKEN` secret the Worker refuses every request except `GET /` (safe by default).
- `.secrets/` and `checker/session.json` are gitignored. Never commit tokens, the Instagram session, or her handle.
- GitHub remote: https://github.com/rcz-05/insta-lock-in (private). It may still be empty; if so, push `main` to it.

## Code map

```
worker/src/logic.js     pure state machine, no I/O (readConfig, unlock, status, check, enforceCap, forceLock)
worker/src/index.js     routes, token auth (constant time compare), KV load/save
worker/test/            node:test suites; run `npm test` in worker/
worker/wrangler.toml    KV binding and caps/checklist vars
docs/PLAN.md            full architecture plan
```

Conventions: plain JavaScript ES modules, no build step, no runtime dependencies. Keep logic pure in `logic.js` and test it there with a fixed clock (epoch ms). Add route tests in `routes.test.js` with the in memory KV stub. One logical change per commit.

## Next step (step 2) in detail

- Add `nag(state, cfg, now)` to `logic.js`: in `session`, if `now - last_nag >= interval` return a message and update `last_nag` and `nag_count`. Posts use `POST_NAG_MIN` (5); Reels alternate `REEL_NAG_MIN` (2,3) by `nag_count`. Text includes minutes left and what is still unticked.
- On cap relock and on checklist relock, emit a final "Done. Delete Instagram now." push.
- Add a `scheduled` handler in `index.js` that loads state, runs `enforceCap` then `nag`, saves, and POSTs to `https://ntfy.sh/${NTFY_TOPIC}` with headers Title, Priority, and `Actions: view, Open checklist, <worker>/checklist?t=<token>`.
- `NTFY_TOPIC` and the public Worker URL become secrets or vars; add `[triggers] crons = ["* * * * *"]` to `wrangler.toml`.
- Test with an injected fake `fetch`.

## Working with Rayan

- Writing style for anything he reads: no hyphens or em dashes, plain prose over bullets, simple minimal language, polished and ready to use.
- He does the iPhone steps himself; give exact tap by tap instructions.
- Ask before anything that touches his Instagram account.
