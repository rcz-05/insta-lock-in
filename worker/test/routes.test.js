import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, tick } from "../src/index.js";
import { MINUTE } from "../src/logic.js";

// In memory stand in for Workers KV.
function fakeEnv(extra = {}) {
  const store = new Map();
  return {
    TOKEN: "secret-123",
    LOCK_KV: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
    },
    ...extra,
  };
}

const T0 = Date.UTC(2026, 8, 27, 20, 0, 0);
const req = (method, path, body, token = "secret-123") =>
  new Request(`https://lock.example${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test("health check needs no token", async () => {
  const r = await handle(req("GET", "/", null, null), fakeEnv(), T0);
  assert.equal(r.status, 200);
});

test("missing or wrong token is rejected", async () => {
  const env = fakeEnv();
  assert.equal((await handle(req("GET", "/status", null, null), env, T0)).status, 401);
  assert.equal((await handle(req("GET", "/status", null, "nope"), env, T0)).status, 401);
});

test("no TOKEN secret means everything is refused", async () => {
  const env = fakeEnv({ TOKEN: undefined });
  assert.equal((await handle(req("GET", "/status", null, ""), env, T0)).status, 401);
});

test("token in query works for links from pushes and Safari", async () => {
  const r = await handle(new Request("https://lock.example/status?t=secret-123"), fakeEnv(), T0);
  assert.equal(r.status, 200);
});

test("full cycle over HTTP", async () => {
  const env = fakeEnv();
  let r = await (await handle(req("GET", "/status"), env, T0)).json();
  assert.equal(r.open, false);

  r = await (await handle(req("POST", "/unlock", { reason: "post", items: [{ id: "C1" }] }), env, T0)).json();
  assert.deepEqual(r, { added: 1, state: "unlocked", cap_minutes: 15 });

  r = await (await handle(req("GET", "/status"), env, T0 + MINUTE)).json();
  assert.equal(r.open, true);
  assert.equal(r.minutes_left, 15);
  assert.match(r.message, /her new post/);

  r = await (await handle(req("POST", "/done", { checked: ["view", "like", "comment"] }), env, T0 + 5 * MINUTE)).json();
  assert.equal(r.done, true);
  assert.equal(r.state, "locked");

  r = await (await handle(req("GET", "/status"), env, T0 + 6 * MINUTE)).json();
  assert.equal(r.open, false);

  const full = await (await handle(req("GET", "/state"), env, T0 + 6 * MINUTE)).json();
  assert.equal(full.log.length, 1);
  assert.equal(full.log[0].minutes, 4);
});

test("bad bodies return 400, unknown routes 404", async () => {
  const env = fakeEnv();
  const bad = new Request("https://lock.example/unlock", {
    method: "POST",
    headers: { "x-token": "secret-123" },
    body: "not json",
  });
  assert.equal((await handle(bad, env, T0)).status, 400);
  assert.equal((await handle(req("POST", "/unlock", { reason: "story", items: [{ id: "x" }] }), env, T0)).status, 400);
  assert.equal((await handle(req("GET", "/nope"), env, T0)).status, 404);
});

test("manual lock works", async () => {
  const env = fakeEnv();
  await handle(req("POST", "/unlock", { reason: "reels", items: [{ id: "R1" }] }), env, T0);
  const r = await (await handle(req("POST", "/lock"), env, T0)).json();
  assert.equal(r.state, "locked");
});

// Records every push instead of calling Bark.
function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    return new Response("ok");
  };
  fn.calls = calls;
  return fn;
}

const pushEnv = () =>
  fakeEnv({ BARK_KEY: "key-abc", WORKER_URL: "https://lock.example/" });

test("cron nags on schedule with a checklist action", async () => {
  const env = pushEnv();
  const f = fakeFetch();
  await handle(req("POST", "/unlock", { reason: "post", items: [{ id: "C1" }] }), env, T0, f);
  await handle(req("GET", "/status"), env, T0, f);
  assert.deepEqual(await tick(env, T0 + 4 * MINUTE, f), []);
  const sent = await tick(env, T0 + 5 * MINUTE, f);
  assert.equal(sent.length, 1);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, "https://api.day.app/push");
  assert.equal(call.method, "POST");
  const push = JSON.parse(call.body);
  assert.equal(push.device_key, "key-abc");
  assert.equal(push.title, "Instagram check");
  assert.equal(push.level, "timeSensitive");
  assert.equal(push.group, "insta-lock-in");
  assert.equal(push.url, "https://lock.example/checklist?t=secret-123");
  assert.match(push.body, /10 min left/);
  // Same minute again does not repeat the nag.
  assert.deepEqual(await tick(env, T0 + 5 * MINUTE + 30000, f), []);
});

test("cron relocks at the cap and sends the final push", async () => {
  const env = pushEnv();
  const f = fakeFetch();
  await handle(req("POST", "/unlock", { reason: "reels", items: [{ id: "R1" }] }), env, T0, f);
  await handle(req("GET", "/status"), env, T0, f);
  const sent = await tick(env, T0 + 11 * MINUTE, f);
  assert.equal(sent.length, 1);
  const last = JSON.parse(f.calls.at(-1).body);
  assert.equal(last.body, "Done. Delete Instagram now.");
  assert.equal(last.url, undefined);
  const s = await (await handle(req("GET", "/state"), env, T0 + 12 * MINUTE, f)).json();
  assert.equal(s.state, "locked");
  assert.equal(s.log.at(-1).how, "cap");
  assert.deepEqual(await tick(env, T0 + 13 * MINUTE, f), []);
});

test("finishing the checklist sends the final push", async () => {
  const env = pushEnv();
  const f = fakeFetch();
  await handle(req("POST", "/unlock", { reason: "post", items: [{ id: "C1" }] }), env, T0, f);
  await handle(req("GET", "/status"), env, T0, f);
  await handle(req("POST", "/done", { checked: ["view", "like", "comment"] }), env, T0 + MINUTE, f);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].body).body, "Done. Delete Instagram now.");
});

test("no key means no pushes, and a failing push does not break routes", async () => {
  const quiet = fakeFetch();
  const env = fakeEnv();
  await handle(req("POST", "/unlock", { reason: "post", items: [{ id: "C1" }] }), env, T0, quiet);
  await handle(req("GET", "/status"), env, T0, quiet);
  await tick(env, T0 + 5 * MINUTE, quiet);
  assert.equal(quiet.calls.length, 0);

  const env2 = pushEnv();
  const broken = async () => {
    throw new Error("network down");
  };
  await handle(req("POST", "/unlock", { reason: "post", items: [{ id: "C1" }] }), env2, T0, broken);
  await handle(req("GET", "/status"), env2, T0, broken);
  const r = await handle(req("POST", "/done", { checked: ["view", "like", "comment"] }), env2, T0, broken);
  assert.equal(r.status, 200);
  assert.equal((await tick(env2, T0 + MINUTE, broken)).length, 0);
});
