# CLAUDE.md

Context for any Claude Code session working in this repo. Read this first, then `docs/PLAN.md` for the full architecture.

## What this is

Rayan's personal tool to keep Instagram locked on his iPhone until one specific person (her Instagram handle goes in config later, never in git) posts or sends him Reels. When she does, Instagram opens for a short capped session, he gets nagged by push notifications until he ticks a checklist (view, like, comment for posts; watched, replied for Reels), then it locks again. Goal: cut Instagram screen time hard, for free.

Planning happened in a Claude (Cowork) session on 2026-09-27. Decisions below are settled; do not relitigate them unless Rayan asks.

## Settled decisions

- Platform: iPhone. No paid Apple Developer account, so no Screen Time API. Everything is free.
- The lock is a gate on open, not deletion: an iOS Shortcuts automation ("Instagram is opened", Run Immediately) calls `GET /status` and runs Go to Home Screen when locked.
- State lives in a Cloudflare Worker with KV. Single JSON record, key `state`.
- Push reminders go through Bark (free iOS app, api.day.app, straight to Apple push), sent by a Worker cron that runs every minute. Switched from ntfy on 2026-09-27: ntfy's iPhone relay never showed banners on Rayan's phone (known ntfy bug), Bark did on the first try.
- Detection runs on the MacBook: Playwright with a saved Instagram session, checking her profile and the DM thread with her every 20 minutes via launchd. Slow, home network only, never from a cloud server. Fallback: paste her post link.
- Time cap per session: posts 15 min; Reels 10 min plus 1 per Reel. The clock starts on first open after an unlock. The cap relocks even if the checklist is ignored.
- Items that already unlocked once never unlock again (`seen` list, capped at 200).
- Instagram stays installed. The gate is the lock; pushes never tell Rayan to delete the app (changed 2026-09-27).

## Requested scope, not built yet (from Rayan, 2026-09-27)

Plan these into step 5 (Mac checker) and the Worker before building it. Details still to confirm with Rayan.

- A list of people instead of one person. Rayan picks the handles; they live in `checker/.env` (gitignored), never in git or chat logs if avoidable.
- Triggers per person: new posts, new Reels on their profile, new Stories, and Reels or messages they send him in DMs.
- Stories: detect that a new story exists without opening it, so Rayan never shows up as a viewer from the checker.
- DMs: read the inbox list preview only. Opening a thread on web marks it Seen, so the checker must never open threads.
- Wording: messages say "her" today (`describe()` and `ask()` in `logic.js`); switch to naming the person once there are several.
- Open question: a push the moment something unlocks ("New post from X. Your 15 minutes start when you open Instagram."). Today nothing tells Rayan an unlock happened.

## Status

| Step | State |
| --- | --- |
| 1. Worker and state (`/status`, `/unlock`, `/done`, `/lock`, `/state`) | Done, deployed 2026-09-27, live cycle verified with curl |
| 2. Bark pushes and cron nag loop | Done, deployed, 33 tests passing, Lock Screen delivery confirmed |
| 3. Shortcuts gate on iPhone | Todo (Rayan does it on the phone; give exact steps) |
| 4. Checklist page (`GET /checklist`) | Todo |
| 5. Mac checker (Playwright) | Todo; needs her handle and the DM thread URL from Rayan |
| 6. launchd schedule | Todo |
| 7. Hardening (heartbeat, Screen Time web block) | Todo |
| 8. Full cycle test | Todo |

## Infra facts

- Cloudflare account id: `f5c3178b0fbde14313e6eefc984feaaf`.
- KV namespace `insta-lock-in-LOCK_KV` already exists, id `81eb575709fc4ea9b56b9aa702efd710`, already set in `worker/wrangler.toml`.
- Worker is live at `https://insta-lock-in.rayancaszou.workers.dev`. Redeploy from `worker/` with `npx wrangler deploy`. The `TOKEN` secret is set; its value is in `.secrets/token` (read it inside commands, never print it).
- Bark device key is the `BARK_KEY` secret; its value is in `.secrets/bark_key` (never commit or print it). Pushes are time sensitive and tapping a nag opens the checklist. The cron runs every minute.
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

## Next step (step 3)

Shortcuts gate on the iPhone, done by Rayan with tap by tap steps: automation App, Instagram, Is Opened, Run Immediately; Get Contents of URL `/status` with header `X-Token`; Get Dictionary Value `state`; if `locked`, Show Notification then Go to Home Screen; otherwise Show Notification with `message`. Step 2 notes: `nag()` and `finalPush()` live in `logic.js`; `tick()` in `index.js` is the cron body and `notify()` sends through Bark; both take an injectable `fetch` for tests.

## Working with Rayan

- Writing style for anything he reads: no hyphens or em dashes, plain prose over bullets, simple minimal language, polished and ready to use.
- He does the iPhone steps himself; give exact tap by tap instructions.
- Ask before anything that touches his Instagram account.
