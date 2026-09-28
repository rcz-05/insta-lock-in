// Read only access to Instagram through a logged in browser page. Every call
// is a GET the Instagram website itself makes; nothing here likes, views a
// story, or opens a chat, so nobody sees Rayan as "seen" or "viewed".

import { readProfile } from "./scan.js";

// Public app id the Instagram website sends with its own API calls.
const APP_ID = "936619743392459";

export class LoggedOut extends Error {}

async function get(page, path) {
  const r = await page.evaluate(
    async ({ path, appId }) => {
      const res = await fetch(path, {
        credentials: "include",
        headers: { "x-ig-app-id": appId, "x-requested-with": "XMLHttpRequest" },
      });
      const text = await res.text();
      return { status: res.status, url: res.url, text };
    },
    { path, appId: APP_ID },
  );
  if (r.status === 401 || r.status === 403 || r.url.includes("/accounts/login")) {
    throw new LoggedOut(`logged out (${r.status} on ${path})`);
  }
  let body;
  try {
    body = JSON.parse(r.text);
  } catch {
    throw new Error(`not JSON (${r.status}) from ${path}`);
  }
  if (body.require_login) throw new LoggedOut(`login required on ${path}`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${path}: ${body.message ?? ""}`);
  return body;
}

export class RateLimited extends Error {}

/**
 * Open a profile page the way a person would and read the data the page
 * itself loads: newest posts and Reels, and the time of the latest story
 * (seen from the profile, so the story is never opened or marked viewed).
 */
export async function profile(page, handle) {
  const bodies = [];
  let limited = false;
  const onResponse = async (res) => {
    const url = res.url();
    if (!/instagram\.com\/(graphql|api)\//.test(url)) return;
    if (res.status() === 429) limited = true;
    // Instagram labels most of these text/javascript even though they are
    // JSON, sometimes behind a "for (;;);" guard.
    try {
      const text = await res.text();
      bodies.push(JSON.parse(text.replace(/^for \(;;\);/, "")));
    } catch {
      // Not JSON, or no body (redirect or aborted); ignore.
    }
  };
  page.on("response", onResponse);
  try {
    const res = await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/`, { waitUntil: "domcontentloaded" });
    if (res?.status() === 429) limited = true;
    if (page.url().includes("/accounts/login")) throw new LoggedOut("redirected to login");
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    // Data embedded in the page HTML itself.
    const embedded = await page.$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent));
    for (const text of embedded) {
      try {
        bodies.push(JSON.parse(text));
      } catch {
        // Not JSON; skip.
      }
    }
  } finally {
    page.off("response", onResponse);
  }
  if (limited) throw new RateLimited(`rate limited on @${handle}`);
  const p = readProfile(bodies, handle);
  if (!p.id && p.posts.length === 0) throw new Error(`no profile data found for @${handle}`);
  return p;
}

/** The inbox list, fetched once per run. Never opens a thread. */
export async function inbox(page) {
  return get(page, "/api/v1/direct_v2/inbox/?persistentBadging=true&limit=20&thread_message_limit=10");
}

/**
 * Messages from one person that Rayan has not replied to yet, read from the
 * inbox list only (opening the thread would mark it Seen). Anything sent
 * before his latest message in the thread counts as answered.
 * Returns [{ id, ts, url }], newest first.
 */
export function messagesFrom(box, handle) {
  const viewer = String(box?.viewer?.pk ?? box?.viewer?.id ?? "");
  const threads = box?.inbox?.threads ?? [];
  const thread = threads.find(
    (t) => !t.is_group && (t.users ?? []).some((u) => u.username?.toLowerCase() === handle),
  );
  if (!thread) return [];
  // Instagram gives message times in microseconds.
  const ms = (it) => Math.floor(Number(it.timestamp) / 1000);
  const items = thread.items ?? [];
  const lastReply = Math.max(0, ...items.filter((it) => String(it.user_id) === viewer).map(ms));
  return items
    .filter((it) => String(it.user_id) !== viewer && ms(it) > lastReply)
    .map((it) => ({
      id: `dm:${it.item_id}`,
      ts: ms(it),
      url: `https://www.instagram.com/direct/t/${thread.thread_id}/`,
    }));
}
