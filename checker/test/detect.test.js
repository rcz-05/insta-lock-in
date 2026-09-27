import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, diff, unlockBodies, parseEnv, handles } from "../src/detect.js";

const T0 = Date.UTC(2026, 8, 27, 20, 0, 0);
const MIN = 60 * 1000;
const post = (id, ts) => ({ id, ts, url: `https://www.instagram.com/p/${id}/` });

test("first run only records a baseline", () => {
  const r = diff(emptyState(), "post:maya", [post("A", T0 - 5 * MIN), post("B", T0 - 60 * MIN)], T0);
  assert.deepEqual(r.fresh, []);
  assert.deepEqual(r.state.baselines["post:maya"], { since: T0, ids: ["A", "B"] });
});

test("a new post after the baseline is fresh, once", () => {
  let s = diff(emptyState(), "post:maya", [post("A", T0 - 5 * MIN)], T0).state;
  let r = diff(s, "post:maya", [post("C", T0 + 10 * MIN), post("A", T0 - 5 * MIN)], T0 + 20 * MIN);
  assert.deepEqual(r.fresh.map((it) => it.id), ["C"]);
  r = diff(r.state, "post:maya", [post("C", T0 + 10 * MIN), post("A", T0 - 5 * MIN)], T0 + 40 * MIN);
  assert.deepEqual(r.fresh, []);
});

test("old or pinned posts that show up later never unlock", () => {
  const s = diff(emptyState(), "post:maya", [post("A", T0 - 5 * MIN)], T0).state;
  const r = diff(s, "post:maya", [post("OLD", T0 - 90 * 24 * 60 * MIN), post("A", T0 - 5 * MIN)], T0 + 20 * MIN);
  assert.deepEqual(r.fresh, []);
  assert.ok(r.state.baselines["post:maya"].ids.includes("OLD"));
});

test("sources are tracked separately and input is not mutated", () => {
  const s0 = emptyState();
  const s1 = diff(s0, "post:maya", [], T0).state;
  assert.deepEqual(s0, emptyState());
  const r = diff(s1, "story:maya", [{ id: "S1", ts: T0 + MIN }], T0 + 2 * MIN);
  assert.deepEqual(r.fresh, []);
  assert.ok(r.state.baselines["story:maya"]);
});

test("unlock bodies group by kind and name who it is from", () => {
  const bodies = unlockBodies([
    { kind: "post", handle: "maya", items: [post("C", T0)] },
    { kind: "story", handle: "maya", items: [{ id: "story:1", ts: T0 }] },
    { kind: "post", handle: "sam", items: [post("D", T0)] },
  ]);
  assert.deepEqual(bodies, [
    {
      reason: "post",
      items: [
        { id: "C", url: "https://www.instagram.com/p/C/", from: "maya" },
        { id: "D", url: "https://www.instagram.com/p/D/", from: "sam" },
      ],
    },
    { reason: "story", items: [{ id: "story:1", url: undefined, from: "maya" }] },
  ]);
});

test("env file and handle parsing", () => {
  const env = parseEnv("# comment\nPOST_HANDLES= @Maya, sam ,maya\nDM_HANDLE=\"maya\"\n\nWORKER_URL=https://x.dev\n");
  assert.deepEqual(handles(env.POST_HANDLES), ["maya", "sam"]);
  assert.equal(env.DM_HANDLE, "maya");
  assert.deepEqual(handles(undefined), []);
});
