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
  assert.deepEqual(r, { added: 1, state: "unlocked", cap_minutes: 30 });

  r = await (await handle(req("GET", "/status"), env, T0 + MINUTE)).json();
  assert.equal(r.open, true);
  assert.equal(r.minutes_left, 30);
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
  assert.equal((await handle(req("POST", "/unlock", { reason: "reels", items: [{ id: "x" }] }), env, T0)).status, 400);
  assert.equal((await handle(req("GET", "/nope"), env, T0)).status, 404);
});

test("manual lock works", async () => {
  const env = fakeEnv();
  await handle(req("POST", "/unlock", { reason: "dm", items: [{ id: "M1" }] }), env, T0);
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
  assert.deepEqual(await tick(env, T0 + 9 * MINUTE, f), []);
  const sent = await tick(env, T0 + 10 * MINUTE, f);
  assert.equal(sent.length, 1);
  assert.equal(f.calls.length, 2); // unlock push, then the nag
  const call = f.calls[1];
  assert.equal(call.url, "https://api.day.app/push");
  assert.equal(call.method, "POST");
  const push = JSON.parse(call.body);
  assert.equal(push.device_key, "key-abc");
  assert.equal(push.title, "Instagram check");
  assert.equal(push.level, "timeSensitive");
  assert.equal(push.group, "insta-lock-in");
  assert.equal(push.url, "https://lock.example/checklist?t=secret-123");
  assert.match(push.body, /20 min left/);
  // Same minute again does not repeat the nag.
  assert.deepEqual(await tick(env, T0 + 10 * MINUTE + 30000, f), []);
});

test("cron relocks at the cap and sends the final push", async () => {
  const env = pushEnv();
  const f = fakeFetch();
  await handle(req("POST", "/unlock", { reason: "story", items: [{ id: "S1" }] }), env, T0, f);
  await handle(req("GET", "/status"), env, T0, f);
  const sent = await tick(env, T0 + 10 * MINUTE, f);
  assert.equal(sent.length, 1);
  const last = JSON.parse(f.calls.at(-1).body);
  assert.equal(last.body, "Time is up. Instagram is locked again.");
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
  assert.equal(f.calls.length, 2); // unlock push, then the final push
  assert.equal(JSON.parse(f.calls[1].body).body, "Done. Instagram is locked again.");
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

test("unlocking sends a push, a repeat unlock does not", async () => {
  const env = pushEnv();
  const f = fakeFetch();
  const body = { reason: "post", items: [{ id: "C1", from: "Maya" }] };
  await handle(req("POST", "/unlock", body), env, T0, f);
  await handle(req("POST", "/unlock", body), env, T0 + MINUTE, f);
  assert.equal(f.calls.length, 1);
  const push = JSON.parse(f.calls[0].body);
  assert.equal(push.title, "Instagram unlocked");
  assert.equal(push.body, "New post from Maya. Your 30 minutes start when you open Instagram.");
});

test("checklist page lists the actions without starting the clock", async () => {
  const env = fakeEnv();
  await handle(req("POST", "/unlock", { reason: "post", items: [{ id: "C1", url: "https://www.instagram.com/p/C1/", from: "<b>Maya</b>" }] }), env, T0);
  const r = await handle(new Request("https://lock.example/checklist?t=secret-123"), env, T0 + MINUTE);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  const html = await r.text();
  for (const a of ["view", "like", "comment"]) assert.match(html, new RegExp(`value="${a}"`));
  assert.match(html, /Your 30 minutes start when you open Instagram/);
  assert.match(html, /href="https:\/\/www.instagram.com\/p\/C1\/"/);
  assert.match(html, /&lt;b&gt;Maya&lt;\/b&gt;/);
  assert.doesNotMatch(html, /secret-123/);
  const s = await (await handle(req("GET", "/state"), env, T0 + MINUTE)).json();
  assert.equal(s.state, "unlocked");
});

test("checklist page shows ticked items and the locked state", async () => {
  const env = fakeEnv();
  await handle(req("POST", "/unlock", { reason: "dm", items: [{ id: "M1" }] }), env, T0);
  await handle(req("GET", "/status"), env, T0);
  await handle(req("POST", "/done", { checked: ["watched"] }), env, T0 + MINUTE);
  let html = await (await handle(new Request("https://lock.example/checklist?t=secret-123"), env, T0 + 2 * MINUTE)).text();
  assert.match(html, /value="watched" checked disabled/);
  assert.match(html, /Saw what she sent/);
  assert.match(html, /8 min left/);
  await handle(req("POST", "/done", { checked: ["replied"] }), env, T0 + 3 * MINUTE);
  html = await (await handle(new Request("https://lock.example/checklist?t=secret-123"), env, T0 + 3 * MINUTE)).text();
  assert.match(html, /Instagram is locked/);
  assert.equal((await handle(new Request("https://lock.example/checklist"), env, T0)).status, 401);
});
