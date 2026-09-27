# Insta Lock In: Architecture Plan

Written 2026-09-27. Copied from the plan doc in the Claude project "Insta_lock_in" so the repo carries it.

## Summary

Build a free "gate" instead of a delete and reinstall cycle. Instagram stays locked by default. A checker on the Mac unlocks it only when her account posts or she sends a Reel. A nag loop pushes a notification every 5 minutes (posts) or every 2 to 3 minutes (Reels) until the checklist is ticked, which locks it again.

iOS does not let any app delete, block, or detect installs of another app for free, and it cannot see likes or comments. So the lock happens at the moment Instagram opens (an iOS Shortcuts automation that sends you to the Home Screen), the cycle state lives on a tiny free server, and detection of your own actions is replaced by a checklist you confirm. Deleting the app becomes optional.

Target: about 4 hours, $0. iOS Shortcuts, a Cloudflare Worker (free tier), the Bark app for push (ntfy at first; see step 2), and a Playwright script on the MacBook.

## What iOS allows

The only real app blocking API on iPhone is Apple's Screen Time framework (FamilyControls, ManagedSettings, DeviceActivity). Running it on your own phone needs the paid Apple Developer Program ($99 per year); a free Personal Team cannot get the Family Controls entitlement.

| Need | Possible on iPhone? | Free way |
| --- | --- | --- |
| Delete Instagram automatically | No | Nag until deleted, or skip deleting and use the gate |
| Block installing only Instagram | Paid Screen Time API only | Gate on open makes installing pointless |
| Stop Instagram from opening | Yes | Shortcuts automation "Instagram is opened", Run Immediately, Go to Home Screen |
| Know she posted | Not from the phone | Mac script checks her profile logged in as you |
| Know she sent a Reel | Not from the phone | Same Mac script reads the DM thread with her |
| Know you liked, viewed, commented | No | Checklist you confirm |
| Nag every few minutes | Not with Shortcuts alone | Worker cron sends pushes through Bark |
| Block instagram.com in Safari | Yes | Screen Time, Content Restrictions, Never Allow |

The official Instagram API cannot help: it only works for Business or Creator accounts, Basic Display was shut down in 2025, and personal DMs are never exposed.

## Design: a gate, not a delete

Three states: `locked` (default, gate sends you Home), `unlocked` (something new from her, clock not started), `session` (clock running, nags firing). Unlock only from her activity; relock from the checklist or the time cap.

1. Gate instead of delete. Blocks instantly whether installed or not.
2. Hard time cap per session. Post: 30 min. Story or message: 10 min. Cap relocks even if the checklist is ignored. This is what cuts screen hours.
3. Scoped unlocks. Each unlock names exactly what it is for; the checklist lists those items.
4. Configurable checklist. Posts: view, like, comment. Stories: watched. Messages: watched, replied. Can require just one via config.

## Architecture

```
Instagram ──reads──> Mac checker ──POST /unlock──> Cloudflare Worker (state in KV)
                                                        │  status, nags, done
             ┌──────────────────────┬───────────────────┴───────┐
        Shortcuts gate          Bark app                 Checklist page
```

Worker endpoints (all need the shared secret as header `X-Token` or query `?t=`):

| Endpoint | Called by | Does |
| --- | --- | --- |
| GET /status | Shortcuts gate | locked or open; first open after unlock starts the clock |
| POST /unlock | Mac checker | sets unlocked with new items, cap, checklist |
| GET /checklist | You, in Safari | page with the items and checkboxes (step 4) |
| POST /done | Checklist page | records ticks; all required ticked relocks and sends the delete prompt |
| Cron, every minute | Cloudflare | sends a nag if due, relocks at the cap, logs minutes (step 2) |

Mac checker: Node or Python Playwright with a saved Instagram session file (not the password). Opens her profile, reads the newest /p/ or /reel/ link; opens the DM thread with her, reads new Reel shares; compares to last seen; calls /unlock only when something is new. launchd runs it every 20 minutes.

iPhone: no custom app. Two Shortcuts automations (Instagram opened, Instagram closed), the Bark app with its private device key, and a Home Screen bookmark to the checklist page.

## Detection options

| Option | Private account? | Notes |
| --- | --- | --- |
| 1. Mac Playwright with your session (chosen) | Yes if you follow her | Against Instagram terms; keep it slow (20 to 30 min), home network, never from a cloud server |
| 2. Fallback: paste her post link | Yes | Worker only accepts a code it has not seen |
| 3. She is the key holder | Yes | A private link she taps; depends on her |
| 4. Business Discovery API | No | Both need Business or Creator accounts |
| 5. Third party RSS | No | Unreliable |

When the Mac is asleep nothing unlocks. That is fine: default is locked.

## Reminder loop

| Setting | Posts | Stories and messages |
| --- | --- | --- |
| Nag interval | 10 min | 5 min |
| Time cap | 30 min | 10 min |
| Nag text | "Seen her post? Liked? Commented? Tick it and close the app." | "Seen what she sent? Replied? Tick it and close the app." |
| Final push | "Done. Instagram is locked again." (cap: "Time is up. Instagram is locked again.") | same |

Bark push format:

```
POST https://api.day.app/push
{ "device_key": "<key>", "title": "Instagram check", "level": "timeSensitive",
  "group": "insta-lock-in", "url": "https://<worker>/checklist?t=<token>",
  "body": "Seen her post? Liked? Commented? Tick it and close the app. 9 min left." }
```

The clock starts on first open after an unlock, not at the unlock. The "Instagram opened" automation also shows a banner with minutes left.

## Build plan

1. Worker and state (45 min). DONE.
2. Push (10 min). Install Bark on iPhone and store its device key as a secret. (ntfy was tried first; its iPhone relay never showed banners.) Add cron `* * * * *` and nag logic.
3. Shortcuts gate (30 min). Automation: App, Instagram, Is Opened, Run Immediately. Get Contents of URL /status with X-Token; Get Dictionary Value "state"; if "locked": Show Notification then Go to Home Screen; else Show Notification with "message".
4. Checklist page (30 min). HTML served by the Worker; Done button POSTs /done. Add to Home Screen.
5. Mac checker (60 to 90 min). Playwright, saved session, profile and DM thread checks, POST /unlock. Last seen values live in the Worker.
6. Schedule (15 min). launchd plist in ~/Library/LaunchAgents, StartInterval 1200, log to a file.
7. Hardening (20 min). See below.
8. Full cycle test (20 min).

## Loopholes and hardening

| Cheat | Fix |
| --- | --- |
| Turn off the Shortcuts automation | Nightly 9 p.m. automation pings /heartbeat; missing heartbeat sends an alert |
| instagram.com in Safari | Screen Time, Content and Privacy Restrictions, Never Allow |
| Another browser | Delete it or put it under a 1 minute App Limit |
| Instagram on the Mac | Same Never Allow list in Mac Screen Time |
| Change Screen Time settings | Someone trusted sets the Screen Time passcode |
| Scroll the feed during an unlock | Time cap relocks |
| Tick the checklist without doing it | Harmless: ends your own session early |

Extra: Worker logs minutes per session and sends a Sunday summary push. Keep Instagram notifications off except messages.

## Cost

$0. Upgrade path ($99 per year): native app on the Screen Time API with a real shield, DeviceActivity thresholds for nags, and app installs switched off. Worker and checker stay the same.
