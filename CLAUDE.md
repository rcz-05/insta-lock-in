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
- Detection runs on the MacBook: Playwright with a saved Instagram session (`checker/`). Runs every 12 hours (changed 2026-09-27 from 20 minutes, to keep the account safe): launchd `StartCalendarInterval` at 9:00 and 21:00, so a run missed while the Mac sleeps happens on wake. Slow, home network only, never from a cloud server.
- Unlock kinds (changed 2026-09-27): `post` (a post or Reel on her profile) gets 30 min with a nag every 10 min; `story` and `dm` (a message or Reel she sends) get a flat 10 min with a nag every 5 min. The clock starts on first open after an unlock. The cap relocks even if the checklist is ignored. Something new during an open session gets at least its full time from that moment; a mixed window nags on the shortest interval.
- Items that already unlocked once never unlock again (`seen` list, capped at 200).
- Instagram stays installed. The gate is the lock; pushes never tell Rayan to delete the app (changed 2026-09-27).

## Requested scope, not built yet (from Rayan, 2026-09-27)

Plan these into step 5 (Mac checker) and the Worker before building it. Details still to confirm with Rayan.

- A list of people instead of one person. Rayan picks the handles; they live in `checker/.env` (gitignored), never in git or chat logs if avoidable.
- Accounts live in `checker/.env` (gitignored): `POST_HANDLES`, `STORY_HANDLES`, `DM_HANDLES` (comma lists). Messages count from two people as of 2026-09-27. Rayan earlier said stories should be only her plus one other person, but his `.env` lists every post account for stories too; he is deciding which he wants.
- Stories: detect that a new story exists without opening it, so Rayan never shows up as a viewer from the checker.
- DMs: read the inbox list preview only. Opening a thread on web marks it Seen, so the checker must never open threads.
- Wording: messages say "her" today (`describe()` and `ask()` in `logic.js`); switch to naming the person once there are several.
- Unlock push is built: `unlockPush()` in `logic.js`, sent from `/unlock`. Items may carry an optional `from` display name the checker should fill in.

## Status

| Step | State |
| --- | --- |
| 1. Worker and state (`/status`, `/unlock`, `/done`, `/lock`, `/state`) | Done, deployed 2026-09-27, live cycle verified with curl |
| 2. Bark pushes and cron nag loop | Done, deployed, Lock Screen delivery confirmed |
| 3. Shortcuts gate on iPhone | Done 2026-09-27; locked bounces Home, unlocked stays open, both verified on Rayan's phone |
| 4. Checklist page (`GET /checklist`) | Done, deployed; waiting on Rayan to try it from a reminder |
| 5. Mac checker (Playwright) | Working live 2026-09-28: baselines saved, a DM from the friend unlocked end to end. 5 of 8 profiles read posts; 3 read none (likely private or empty, Rayan to confirm) |
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
worker/src/index.js     routes, token auth (constant time compare), KV load/save, Bark pushes, cron
worker/src/checklist.js checklist page HTML (pure; viewing it never starts the clock)
worker/test/            node:test suites; run `npm test` in worker/
worker/wrangler.toml    KV binding and caps/checklist vars
checker/check.js        one checker run (`npm run check`, `npm run dry` prints without unlocking)
checker/login.js        one time visible login that saves checker/session.json
checker/src/detect.js   pure baseline and diff logic, tested in checker/test/
checker/src/instagram.js read only Instagram web API calls (profile, stories, inbox list)
docs/PLAN.md            full architecture plan
```

Conventions: plain JavaScript ES modules, no build step, no runtime dependencies. Keep logic pure in `logic.js` and test it there with a fixed clock (epoch ms). Add route tests in `routes.test.js` with the in memory KV stub. One logical change per commit.

## Next step (step 5)

Mac checker: Playwright on the MacBook with a saved Instagram session (`checker/session.json`, gitignored), run by launchd every 12 hours. It visits each profile on the people list for new posts and Reels, checks for a new story on the two story accounts without opening it, reads only the inbox list preview for the one DM person (never open a thread: that marks it Seen), and POSTs `/unlock` with `reason` post, story or dm and `from` set. Ask Rayan before logging in or touching his account. Needs from him: the handles, the story second person, the DM person.

The gate on the phone (step 3) is: automation "Instagram is opened", Run Immediately; Get Contents of URL `/status` with header `X-Token`; Get Value for `state` (type Text); If is `locked`: Show Notification, Go to Home Screen. `nag()`, `finalPush()` and `unlockPush()` live in `logic.js`; `tick()` and `notify()` in `index.js` take an injectable `fetch` for tests.

## Working with Rayan

- Writing style for anything he reads: no hyphens or em dashes, plain prose over bullets, simple minimal language, polished and ready to use.
- He does the iPhone steps himself; give exact tap by tap instructions.
- Ask before anything that touches his Instagram account.
