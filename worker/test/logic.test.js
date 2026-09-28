import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MINUTE,
  initialState,
  readConfig,
  status,
  unlock,
  check,
  forceLock,
  enforceCap,
  minutesLeft,
  nag,
  finalPush,
  unlockPush,
  checkIn,
  staleCheck,
} from "../src/logic.js";

const cfg = readConfig({});
const T0 = Date.UTC(2026, 8, 27, 20, 0, 0);
const post = { reason: "post", items: [{ id: "C1", url: "https://www.instagram.com/p/C1/" }] };
const story = { reason: "story", items: [{ id: "S1" }] };
const dm = { reason: "dm", items: [{ id: "M1" }, { id: "M2" }] };

test("defaults", () => {
  assert.deepEqual(cfg.post, { cap: 30, nag: [10], required: ["view", "like", "comment"] });
  assert.deepEqual(cfg.story, { cap: 10, nag: [5], required: ["watched"] });
  assert.deepEqual(cfg.dm, { cap: 10, nag: [5], required: ["watched", "replied"] });
});

test("config from env, bad numbers fall back", () => {
  const c = readConfig({ POST_CAP_MIN: "20", DM_CAP_MIN: "abc", POST_REQUIRED: "like", STORY_NAG_MIN: "2,3" });
  assert.equal(c.post.cap, 20);
  assert.equal(c.dm.cap, 10);
  assert.deepEqual(c.post.required, ["like"]);
  assert.deepEqual(c.story.nag, [2, 3]);
});

test("locked by default and status says so", () => {
  const r = status(initialState(), T0);
  assert.equal(r.response.open, false);
  assert.equal(r.state.state, "locked");
});

test("post unlock sets cap and checklist", () => {
  const r = unlock(initialState(), post, cfg, T0);
  assert.equal(r.added, 1);
  assert.equal(r.state.state, "unlocked");
  assert.equal(r.state.cap_minutes, 30);
  assert.deepEqual(r.state.kinds, ["post"]);
  assert.deepEqual(r.state.required, ["view", "like", "comment"]);
});

test("story and message unlocks get a flat 10 minutes", () => {
  assert.equal(unlock(initialState(), story, cfg, T0).state.cap_minutes, 10);
  const r = unlock(initialState(), dm, cfg, T0);
  assert.equal(r.state.cap_minutes, 10);
  assert.deepEqual(r.state.required, ["watched", "replied"]);
});

test("same item twice is ignored", () => {
  const a = unlock(initialState(), post, cfg, T0);
  const s = check(status(a.state, T0).state, { checked: ["view", "like", "comment"] }, T0 + MINUTE).state;
  const b = unlock(s, post, cfg, T0 + 2 * MINUTE);
  assert.equal(b.added, 0);
  assert.equal(b.state.state, "locked");
});

test("duplicates inside one request count once", () => {
  const r = unlock(initialState(), { reason: "dm", items: [{ id: "M1" }, { id: "M1" }] }, cfg, T0);
  assert.equal(r.added, 1);
  assert.equal(r.state.items.length, 1);
});

test("bad unlock input throws", () => {
  assert.throws(() => unlock(initialState(), { reason: "reels", items: [{ id: "x" }] }, cfg, T0));
  assert.throws(() => unlock(initialState(), { reason: "post", items: [] }, cfg, T0));
});

test("first open starts the clock, not the unlock", () => {
  const u = unlock(initialState(), post, cfg, T0).state;
  // Opened 3 hours later: full 30 minutes still available.
  const later = T0 + 180 * MINUTE;
  const r = status(u, later);
  assert.equal(r.state.state, "session");
  assert.equal(r.state.session_started, later);
  assert.equal(r.response.minutes_left, 30);
  assert.equal(r.response.open, true);
});

test("minutes left counts down and cap relocks", () => {
  let s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  assert.equal(minutesLeft(s, T0 + 4 * MINUTE), 26);
  const r = status(s, T0 + 30 * MINUTE);
  assert.equal(r.response.open, false);
  assert.equal(r.state.state, "locked");
  assert.equal(r.state.log.at(-1).how, "cap");
  assert.equal(r.state.log.at(-1).minutes, 30);
});

test("enforceCap leaves a live session alone", () => {
  const s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  assert.equal(enforceCap(s, T0 + 5 * MINUTE), s);
});

test("partial checklist keeps it open, full checklist relocks", () => {
  let s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  let r = check(s, { checked: ["view", "like"] }, T0 + 2 * MINUTE);
  assert.equal(r.done, false);
  assert.deepEqual(r.state.checked, ["view", "like"]);
  r = check(r.state, { checked: ["comment"] }, T0 + 3 * MINUTE);
  assert.equal(r.done, true);
  assert.equal(r.state.state, "locked");
  assert.equal(r.state.log.at(-1).how, "checklist");
  assert.equal(r.state.log.at(-1).minutes, 3);
});

test("unknown checklist words are ignored", () => {
  const s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  const r = check(s, { checked: ["scrolled", "view"] }, T0);
  assert.deepEqual(r.state.checked, ["view"]);
});

test("one required action is enough when configured", () => {
  const one = readConfig({ POST_REQUIRED: "like" });
  const s = status(unlock(initialState(), post, one, T0).state, T0).state;
  assert.equal(check(s, { checked: ["like"] }, T0).done, true);
});

test("a message during a post session merges into one window", () => {
  let s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  const r = unlock(s, dm, cfg, T0 + MINUTE);
  assert.equal(r.state.state, "session");
  assert.equal(r.state.reason, "mixed");
  assert.deepEqual(r.state.kinds, ["post", "dm"]);
  assert.equal(r.state.items.length, 3);
  // Plenty of post time left, so the cap does not grow.
  assert.equal(r.state.cap_minutes, 30);
  assert.deepEqual(r.state.required, ["view", "like", "comment", "watched", "replied"]);
});

test("something new late in a session gets its full time from now", () => {
  let s = status(unlock(initialState(), story, cfg, T0).state, T0).state;
  const r = unlock(s, post, cfg, T0 + 8 * MINUTE);
  assert.equal(r.state.cap_minutes, 38);
  assert.equal(minutesLeft(r.state, T0 + 8 * MINUTE), 30);
});

test("seen list survives relock so old posts never unlock again", () => {
  let s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  s = forceLock(s, T0 + MINUTE);
  assert.equal(s.state, "locked");
  assert.deepEqual(s.seen, ["C1"]);
  assert.equal(s.log.at(-1).how, "manual");
});

test("seen list is capped", () => {
  let s = initialState();
  for (let i = 0; i < 250; i++) {
    s = unlock(s, { reason: "dm", items: [{ id: `M${i}` }] }, cfg, T0).state;
  }
  assert.equal(s.seen.length, 200);
  assert.equal(s.seen.at(-1), "M249");
});

const open = (u, t = T0) => status(unlock(initialState(), u, cfg, t).state, t).state;

// Minutes (after T0) at which a nag fires, checking once a minute.
function nagMinutes(s, until) {
  const fired = [];
  for (let m = 1; m <= until; m++) {
    const r = nag(s, cfg, T0 + m * MINUTE);
    if (r.message) fired.push(m);
    s = r.state;
  }
  return fired;
}

test("no nag while locked or before the clock starts", () => {
  assert.equal(nag(initialState(), cfg, T0).message, null);
  const u = unlock(initialState(), post, cfg, T0).state;
  assert.equal(nag(u, cfg, T0 + 60 * MINUTE).message, null);
});

test("post nags every 10 minutes with what is still unticked", () => {
  let s = open(post);
  assert.equal(nag(s, cfg, T0 + 9 * MINUTE).message, null);
  let r = nag(s, cfg, T0 + 10 * MINUTE);
  assert.equal(r.message.body, "Seen her post? Liked? Commented? Tick it and close the app. 20 min left.");
  assert.equal(r.message.checklist, true);
  assert.equal(r.state.nag_count, 1);
  assert.equal(r.state.last_nag, T0 + 10 * MINUTE);
  s = check(r.state, { checked: ["view"] }, T0 + 11 * MINUTE).state;
  assert.equal(nag(s, cfg, T0 + 19 * MINUTE).message, null);
  r = nag(s, cfg, T0 + 20 * MINUTE);
  assert.equal(r.message.body, "Liked? Commented? Tick it and close the app. 10 min left.");
});

test("stories and messages nag every 5 minutes", () => {
  assert.deepEqual(nagMinutes(open(story), 9), [5]);
  assert.deepEqual(nagMinutes(open(dm), 9), [5]);
  const r = nag(open(story), cfg, T0 + 5 * MINUTE);
  assert.equal(r.message.body, "Watched her story? Tick it and close the app. 5 min left.");
  const m = nag(open(dm), cfg, T0 + 5 * MINUTE);
  assert.equal(m.message.body, "Seen what she sent? Replied? Tick it and close the app. 5 min left.");
});

test("a mixed window nags on the shortest interval", () => {
  let s = open(post);
  s = unlock(s, dm, cfg, T0).state;
  assert.deepEqual(nagMinutes(s, 20), [5, 10, 15, 20]);
});

test("final push after checklist or cap, silent on manual lock", () => {
  const s = open(post);
  const done = check(s, { checked: ["view", "like", "comment"] }, T0 + MINUTE).state;
  assert.equal(finalPush(s, done).body, "Done. Instagram is locked again.");
  const capped = enforceCap(s, T0 + 30 * MINUTE);
  assert.equal(finalPush(s, capped).title, "Time is up");
  assert.equal(finalPush(s, capped).body, "Time is up. Instagram is locked again.");
  assert.equal(finalPush(s, forceLock(s, T0)), null);
  assert.equal(finalPush(initialState(), initialState()), null);
  assert.equal(finalPush(s, s), null);
});

test("unlock push says what arrived and when the clock starts", () => {
  const s0 = initialState();
  const a = unlock(s0, { reason: "post", items: [{ id: "C1", from: "Maya" }] }, cfg, T0);
  assert.equal(unlockPush(s0, a.state, a.added, T0).body, "New post from Maya. Your 30 minutes start when you open Instagram.");
  const b = unlock(s0, dm, cfg, T0);
  assert.equal(unlockPush(s0, b.state, b.added, T0).body, "2 new messages from her. Your 10 minutes start when you open Instagram.");
  const c = unlock(s0, story, cfg, T0);
  assert.equal(unlockPush(s0, c.state, c.added, T0).body, "New story from her. Your 10 minutes start when you open Instagram.");
  const opened = status(b.state, T0).state;
  const d = unlock(opened, { reason: "dm", items: [{ id: "M7" }] }, cfg, T0 + 3 * MINUTE);
  assert.equal(unlockPush(opened, d.state, d.added, T0 + 3 * MINUTE).body, "More from her. 10 min left.");
  assert.equal(unlockPush(s0, s0, 0, T0), null);
});

test("check in reminds about an unlock left waiting, not a fresh one", () => {
  const u = unlock(initialState(), post, cfg, T0).state;
  assert.equal(checkIn(u, T0 + 30 * MINUTE).message, null);
  const r = checkIn(u, T0 + 12 * 60 * MINUTE);
  assert.equal(r.message.body, "Her new post is still waiting. Your 30 minutes start when you open Instagram.");
  assert.equal(r.state.last_check, T0 + 12 * 60 * MINUTE);
  assert.equal(r.state.state, "unlocked");
  // Nothing to remind about while locked or in a session.
  assert.equal(checkIn(initialState(), T0).message, null);
  assert.equal(checkIn(status(u, T0).state, T0 + 12 * 60 * MINUTE).message, null);
});

test("a checker silent for over a day triggers one warning", () => {
  let s = checkIn(initialState(), T0).state;
  assert.equal(staleCheck(s, T0 + 25 * 60 * MINUTE).message, null);
  const r = staleCheck(s, T0 + 27 * 60 * MINUTE);
  assert.equal(r.message.title, "Checker stopped");
  assert.equal(staleCheck(r.state, T0 + 28 * 60 * MINUTE).message, null);
  assert.equal(checkIn(r.state, T0 + 29 * 60 * MINUTE).state.stale_alerted, false);
  assert.equal(staleCheck(initialState(), T0).message, null);
});

test("relock keeps the checker check in time", () => {
  const s = { ...open(post), last_check: T0 };
  assert.equal(forceLock(s, T0 + MINUTE).last_check, T0);
});
