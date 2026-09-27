// Cloudflare Worker: HTTP routes, auth, and KV storage around logic.js.

import {
  initialState,
  readConfig,
  status,
  unlock,
  check,
  forceLock,
  enforceCap,
} from "./logic.js";

const KEY = "state";

export async function loadState(env) {
  const raw = await env.LOCK_KV.get(KEY);
  return raw ? { ...initialState(), ...JSON.parse(raw) } : initialState();
}

export async function saveState(env, s) {
  await env.LOCK_KV.put(KEY, JSON.stringify(s));
}

function json(body, code = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status: code,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Length safe, constant time string compare.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function authorized(request, env) {
  if (!env.TOKEN) return false; // refuse everything until a secret is set
  const url = new URL(request.url);
  const given = request.headers.get("x-token") ?? url.searchParams.get("t") ?? "";
  return safeEqual(given, env.TOKEN);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("body must be JSON");
  }
}

export async function handle(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /") return json({ ok: true, name: "insta-lock-in" });
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

  const cfg = readConfig(env);
  let s = await loadState(env);

  try {
    switch (route) {
      case "GET /status": {
        const r = status(s, now);
        await saveState(env, r.state);
        return json(r.response);
      }
      case "POST /unlock": {
        const body = await readJson(request);
        const r = unlock(s, body, cfg, now);
        if (r.added > 0) await saveState(env, r.state);
        return json({ added: r.added, state: r.state.state, cap_minutes: r.state.cap_minutes });
      }
      case "POST /done": {
        const body = await readJson(request);
        const r = check(s, body, now);
        await saveState(env, r.state);
        return json({ done: r.done, state: r.state.state, checked: r.state.checked });
      }
      case "POST /lock": {
        s = forceLock(s, now);
        await saveState(env, s);
        return json({ state: s.state });
      }
      case "GET /state": {
        s = enforceCap(s, now);
        await saveState(env, s);
        return json(s);
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (err) {
    return json({ error: err.message }, 400);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
};
