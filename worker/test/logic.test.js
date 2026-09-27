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
} from "../src/logic.js";

const cfg = readConfig({});
const T0 = Date.UTC(2026, 8, 27, 20, 0, 0);
const post = { reason: "post", items: [{ id: "C1", url: "https://www.instagram.com/p/C1/" }] };
const reels = { reason: "reels", items: [{ id: "R1" }, { id: "R2" }, { id: "R3" }] };

test("defaults", () => {
  assert.equal(cfg.postCapMin, 15);
  assert.deepEqual(cfg.postRequired, ["view", "like", "comment"]);
  assert.deepEqual(cfg.reelRequired, ["watched", "replied"]);
  assert.deepEqual(cfg.reelNagMin, [2, 3]);
});

test("config from env, bad numbers fall back", () => {
  const c = readConfig({ POST_CAP_MIN: "20", REEL_BASE_MIN: "abc", POST_REQUIRED: "like" });
  assert.equal(c.postCapMin, 20);
  assert.equal(c.reelBaseMin, 10);
  assert.deepEqual(c.postRequired, ["like"]);
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
  assert.equal(r.state.cap_minutes, 15);
  assert.deepEqual(r.state.required, ["view", "like", "comment"]);
});

test("reels cap is base plus one per reel", () => {
  const r = unlock(initialState(), reels, cfg, T0);
  assert.equal(r.state.cap_minutes, 13);
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
  const r = unlock(initialState(), { reason: "reels", items: [{ id: "R1" }, { id: "R1" }] }, cfg, T0);
  assert.equal(r.added, 1);
  assert.equal(r.state.items.length, 1);
});

test("bad unlock input throws", () => {
  assert.throws(() => unlock(initialState(), { reason: "story", items: [{ id: "x" }] }, cfg, T0));
  assert.throws(() => unlock(initialState(), { reason: "post", items: [] }, cfg, T0));
});

test("first open starts the clock, not the unlock", () => {
  const u = unlock(initialState(), post, cfg, T0).state;
  // Opened 3 hours later: full 15 minutes still available.
  const later = T0 + 180 * MINUTE;
  const r = status(u, later);
  assert.equal(r.state.state, "session");
  assert.equal(r.state.session_started, later);
  assert.equal(r.response.minutes_left, 15);
  assert.equal(r.response.open, true);
});

test("minutes left counts down and cap relocks", () => {
  let s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  assert.equal(minutesLeft(s, T0 + 4 * MINUTE), 11);
  const r = status(s, T0 + 15 * MINUTE);
  assert.equal(r.response.open, false);
  assert.equal(r.state.state, "locked");
  assert.equal(r.state.log.at(-1).how, "cap");
  assert.equal(r.state.log.at(-1).minutes, 15);
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

test("new reels during a post session merge into one window", () => {
  let s = status(unlock(initialState(), post, cfg, T0).state, T0).state;
  const r = unlock(s, { reason: "reels", items: [{ id: "R9" }, { id: "R10" }] }, cfg, T0 + MINUTE);
  assert.equal(r.state.state, "session");
  assert.equal(r.state.reason, "mixed");
  assert.equal(r.state.items.length, 3);
  assert.equal(r.state.cap_minutes, 17);
  assert.deepEqual(r.state.required, ["view", "like", "comment", "watched", "replied"]);
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
    s = unlock(s, { reason: "reels", items: [{ id: `R${i}` }] }, cfg, T0).state;
  }
  assert.equal(s.seen.length, 200);
  assert.equal(s.seen.at(-1), "R249");
});

const open = (u, t = T0) => status(unlock(initialState(), u, cfg, t).state, t).state;

test("no nag while locked or before the clock starts", () => {
  assert.equal(nag(initialState(), cfg, T0).message, null);
  const u = unlock(initialState(), post, cfg, T0).state;
  assert.equal(nag(u, cfg, T0 + 60 * MINUTE).message, null);
});

test("post nags every 5 minutes with what is still unticked", () => {
  let s = open(post);
  assert.equal(nag(s, cfg, T0 + 4 * MINUTE).message, null);
  let r = nag(s, cfg, T0 + 5 * MINUTE);
  assert.equal(r.message.body, "Seen her post? Liked? Commented? Tick it and close the app. 10 min left.");
  assert.equal(r.message.checklist, true);
  assert.equal(r.state.nag_count, 1);
  assert.equal(r.state.last_nag, T0 + 5 * MINUTE);
  s = check(r.state, { checked: ["view"] }, T0 + 6 * MINUTE).state;
  assert.equal(nag(s, cfg, T0 + 9 * MINUTE).message, null);
  r = nag(s, cfg, T0 + 10 * MINUTE);
  assert.equal(r.message.body, "Liked? Commented? Tick it and close the app. 5 min left.");
});

test("reels alternate 2 then 3 minutes", () => {
  let s = open(reels);
  const fired = [];
  for (let m = 1; m <= 12; m++) {
    const r = nag(s, cfg, T0 + m * MINUTE);
    if (r.message) fired.push(m);
    s = r.state;
  }
  assert.deepEqual(fired, [2, 5, 7, 10, 12]);
});

test("reel nag text counts the reels", () => {
  const r = nag(open(reels), cfg, T0 + 2 * MINUTE);
  assert.equal(r.message.body, "Watched all 3 Reels? Replied? Tick it and close the app. 11 min left.");
  const one = nag(open({ reason: "reels", items: [{ id: "R1" }] }), cfg, T0 + 2 * MINUTE);
  assert.match(one.message.body, /^Watched the Reel\? Replied\?/);
});

test("final push after checklist or cap, silent on manual lock", () => {
  const s = open(post);
  const done = check(s, { checked: ["view", "like", "comment"] }, T0 + MINUTE).state;
  assert.equal(finalPush(s, done).body, "Done. Delete Instagram now.");
  const capped = enforceCap(s, T0 + 15 * MINUTE);
  assert.equal(finalPush(s, capped).title, "Time is up");
  assert.equal(finalPush(s, forceLock(s, T0)), null);
  assert.equal(finalPush(initialState(), initialState()), null);
  assert.equal(finalPush(s, s), null);
});
