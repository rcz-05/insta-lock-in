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
