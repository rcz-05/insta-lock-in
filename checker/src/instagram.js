// Read only access to Instagram through a logged in browser page. It only
// opens pages (a profile, the inbox list) and reads what they load; nothing
// here likes, views a story, or opens a chat, so nobody sees Rayan as "seen"
// or "viewed".

import { readProfile, readInbox } from "./scan.js";

export class LoggedOut extends Error {}

export class RateLimited extends Error {}

/**
 * Open a page the way a person would and collect every JSON body it loads,
 * from its network calls and from the data embedded in its HTML. Instagram
 * labels most of these text/javascript, sometimes behind a "for (;;);" guard.
 */
async function loadPage(page, path, label) {
  const bodies = [];
  let limited = false;
  const onResponse = async (res) => {
    if (!/instagram\.com\/(graphql|api)\//.test(res.url())) return;
    if (res.status() === 429) limited = true;
    try {
      const text = await res.text();
      bodies.push(JSON.parse(text.replace(/^for \(;;\);/, "")));
    } catch {
      // Not JSON, or no body (redirect or aborted); ignore.
    }
  };
  page.on("response", onResponse);
  try {
    const res = await page.goto(`https://www.instagram.com${path}`, { waitUntil: "domcontentloaded" });
    if (res?.status() === 429) limited = true;
    if (/\/accounts\/login|\/challenge/.test(page.url())) throw new LoggedOut("Instagram wants a login or a security check");
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
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
  if (limited) throw new RateLimited(`rate limited on ${label}`);
  return bodies;
}

/**
 * A profile's newest posts and Reels, and the time of the latest story (seen
 * from the profile, so the story is never opened or marked viewed).
 */
export async function profile(page, handle) {
  const bodies = await loadPage(page, `/${encodeURIComponent(handle)}/`, `@${handle}`);
  const p = readProfile(bodies, handle);
  if (!p.id && p.posts.length === 0) throw new Error(`no profile data found for @${handle}`);
  return p;
}

/**
 * The conversation list, read from the inbox page. No conversation is opened,
 * so nothing is marked Seen. (The old inbox API started answering 404 on
 * 2026-10-10.)
 */
export async function inbox(page) {
  const box = readInbox(await loadPage(page, "/direct/inbox/", "the inbox"));
  if (!box) throw new Error("no inbox data found");
  return box;
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
