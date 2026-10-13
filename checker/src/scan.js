// Pure: pull a profile's posts and latest story time out of whatever JSON the
// Instagram profile page loaded. Instagram renames its data often, so this
// walks every object and matches on field shapes instead of fixed paths.

export function readProfile(bodies, handle) {
  const want = handle.toLowerCase();
  const posts = new Map();
  const all = new Set(); // every post found, liked or not
  let id = null;
  let latestStory = 0;

  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const code = typeof v.code === "string" ? v.code : typeof v.shortcode === "string" ? v.shortcode : null;
    const taken = Number(v.taken_at ?? v.taken_at_timestamp);
    const owner = (v.user ?? v.owner)?.username?.toLowerCase();
    if (code && taken > 0 && (!owner || owner === want)) all.add(code);
    // has_liked: Rayan already liked it, so it is not new to him.
    if (code && taken > 0 && (!owner || owner === want) && v.has_liked !== true) {
      const reel = v.product_type === "clips";
      posts.set(code, { id: code, ts: taken * 1000, url: `https://www.instagram.com/${reel ? "reel" : "p"}/${code}/` });
    }
    if (typeof v.username === "string" && v.username.toLowerCase() === want) {
      id ??= v.pk ?? v.id ?? null;
      const story = Number(v.latest_reel_media);
      if (story > latestStory) latestStory = story;
    }
    for (const k in v) walk(v[k]);
  };
  bodies.forEach(walk);

  const stories = latestStory
    ? [{ id: `story:${latestStory}`, ts: latestStory * 1000, url: `https://www.instagram.com/stories/${want}/` }]
    : [];
  return {
    id: id != null ? String(id) : null,
    posts: [...posts.values()].sort((a, b) => b.ts - a.ts),
    postCount: all.size,
    stories,
  };
}

/**
 * Pure: pull the conversation list out of whatever JSON the Instagram inbox
 * page loaded, in the shape messagesFrom() reads:
 * { viewer: { pk }, inbox: { threads: [{ thread_id, is_group, users, items }] } }.
 * Matches on field shapes (a thread has `users` and `slide_messages`) rather
 * than fixed paths. Returns null when no thread list is found at all.
 */
export function readInbox(bodies) {
  const threads = new Map();
  let viewer = null;

  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (Array.isArray(v.users) && Array.isArray(v.slide_messages?.edges)) {
      // Messages carry the sender's messaging id, not the Instagram user id.
      viewer ??= v.viewer?.interop_messaging_user_fbid ?? null;
      const key = String(v.thread_key ?? v.thread_id ?? v.id);
      const items = v.slide_messages.edges
        .map((e) => e?.node)
        .filter((n) => n?.id && n.timestamp_ms)
        .map((n) => ({
          item_id: n.id,
          user_id: String(n.sender_fbid),
          // messagesFrom() expects microseconds, as the old API gave.
          timestamp: String(Number(n.timestamp_ms) * 1000),
        }));
      // The same thread can appear in several responses; keep the fullest.
      if (!threads.has(key) || threads.get(key).items.length < items.length) {
        threads.set(key, {
          thread_id: key,
          is_group: v.is_group === true,
          users: v.users.map((u) => ({ username: u?.username })),
          items,
        });
      }
      return;
    }
    for (const k in v) walk(v[k]);
  };
  bodies.forEach(walk);

  if (threads.size === 0) return null;
  return { viewer: { pk: viewer != null ? String(viewer) : "" }, inbox: { threads: [...threads.values()] } };
}
