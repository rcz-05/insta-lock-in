// Cloudflare Worker: HTTP routes, auth, and KV storage around logic.js.

import {
  initialState,
  readConfig,
  status,
  unlock,
  check,
  forceLock,
  enforceCap,
  nag,
  finalPush,
  unlockPush,
} from "./logic.js";
import { renderChecklist } from "./checklist.js";

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

/**
 * Send one push through Bark (Apple push, straight to the iPhone). Does nothing
 * without BARK_KEY. Never throws, so a push failure cannot break a route or the
 * cron. Tapping a nag opens the checklist. Returns true if sent.
 */
export async function notify(env, msg, fetchFn = fetch) {
  if (!msg || !env.BARK_KEY) return false;
  const body = {
    device_key: env.BARK_KEY,
    title: msg.title,
    body: msg.body,
    group: "insta-lock-in",
    level: msg.level,
  };
  if (msg.checklist && env.WORKER_URL && env.TOKEN) {
    const base = env.WORKER_URL.replace(/\/+$/, "");
    body.url = `${base}/checklist?t=${env.TOKEN}`;
  }
  try {
    const r = await fetchFn("https://api.day.app/push", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Save the new state, then send the final push if a session just ended.
async function commit(env, prev, next, fetchFn) {
  await saveState(env, next);
  await notify(env, finalPush(prev, next), fetchFn);
}

/** One cron run: relock at the cap, nag if due. Returns the pushes it sent. */
export async function tick(env, now = Date.now(), fetchFn = fetch) {
  const cfg = readConfig(env);
  const prev = await loadState(env);
  const capped = enforceCap(prev, now);
  const r = nag(capped, cfg, now);
  if (r.state === prev) return [];
  await saveState(env, r.state);
  const sent = [finalPush(prev, r.state), r.message].filter(Boolean);
  for (const msg of sent) await notify(env, msg, fetchFn);
  return sent;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("body must be JSON");
  }
}

export async function handle(request, env, now = Date.now(), fetchFn = fetch) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /") return json({ ok: true, name: "insta-lock-in" });
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

  const cfg = readConfig(env);
  const prev = await loadState(env);
  let s = prev;

  try {
    switch (route) {
      case "GET /status": {
        const r = status(s, now);
        await commit(env, prev, r.state, fetchFn);
        return json(r.response);
      }
      case "POST /unlock": {
        const body = await readJson(request);
        const r = unlock(s, body, cfg, now);
        if (r.added > 0) {
          await commit(env, prev, r.state, fetchFn);
          await notify(env, unlockPush(prev, r.state, r.added, now), fetchFn);
        }
        return json({ added: r.added, state: r.state.state, cap_minutes: r.state.cap_minutes });
      }
      case "POST /done": {
        const body = await readJson(request);
        const r = check(s, body, now);
        await commit(env, prev, r.state, fetchFn);
        return json({ done: r.done, state: r.state.state, checked: r.state.checked });
      }
      case "POST /lock": {
        s = forceLock(s, now);
        await saveState(env, s);
        return json({ state: s.state });
      }
      case "GET /checklist": {
        // Viewing the page never starts the clock; it only applies the cap.
        s = enforceCap(s, now);
        await commit(env, prev, s, fetchFn);
        return new Response(renderChecklist(s, now), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            // The token is in the page URL; never send it on to Instagram links.
            "referrer-policy": "no-referrer",
          },
        });
      }
      case "GET /state": {
        s = enforceCap(s, now);
        await commit(env, prev, s, fetchFn);
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
  scheduled: (event, env, ctx) => ctx.waitUntil(tick(env, event.scheduledTime)),
};
