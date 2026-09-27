// Read only access to Instagram through a logged in browser page. Every call
// is a GET the Instagram website itself makes; nothing here likes, views a
// story, or opens a chat, so nobody sees Rayan as "seen" or "viewed".

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

/** Profile: user id plus newest posts and Reels as [{ id, ts, url }]. */
export async function profile(page, handle) {
  const body = await get(page, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`);
  const user = body?.data?.user;
  if (!user) throw new Error(`no profile data for ${handle}`);
  const edges = user.edge_owner_to_timeline_media?.edges ?? [];
  const posts = edges.map(({ node }) => ({
    id: node.shortcode,
    ts: node.taken_at_timestamp * 1000,
    url: `https://www.instagram.com/${node.product_type === "clips" ? "reel" : "p"}/${node.shortcode}/`,
  }));
  return { id: user.id, isPrivate: user.is_private, followedByViewer: user.followed_by_viewer, posts };
}

/** Active stories for a user id as [{ id, ts, url }]. Does not mark them seen. */
export async function stories(page, userId, handle) {
  const body = await get(page, `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`);
  const reel = body?.reels?.[userId] ?? body?.reels_media?.find((r) => String(r.id) === String(userId));
  return (reel?.items ?? []).map((it) => ({
    id: `story:${it.pk ?? it.id}`,
    ts: it.taken_at * 1000,
    url: `https://www.instagram.com/stories/${handle}/`,
  }));
}

/**
 * Messages from one person, read from the inbox list only (never opens the
 * thread, which would mark it Seen). Returns [{ id, ts, url }], newest first.
 */
export async function messagesFrom(page, handle) {
  const body = await get(page, "/api/v1/direct_v2/inbox/?persistentBadging=true&limit=20&thread_message_limit=10");
  const viewer = String(body?.viewer?.pk ?? body?.viewer?.id ?? "");
  const threads = body?.inbox?.threads ?? [];
  const thread = threads.find(
    (t) => !t.is_group && (t.users ?? []).some((u) => u.username?.toLowerCase() === handle),
  );
  if (!thread) return [];
  return (thread.items ?? [])
    .filter((it) => String(it.user_id) !== viewer)
    .map((it) => ({
      id: `dm:${it.item_id}`,
      // Instagram gives message times in microseconds.
      ts: Math.floor(Number(it.timestamp) / 1000),
      url: `https://www.instagram.com/direct/t/${thread.thread_id}/`,
    }));
}
