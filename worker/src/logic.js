// Pure state machine for Insta Lock In. No I/O here: every function takes the
// current state plus inputs and returns a new state (and sometimes a response).
// Times are epoch milliseconds so tests can pass a fixed clock.

export const MINUTE = 60 * 1000;
const SEEN_LIMIT = 200;

// What can unlock Instagram: a post (or Reel) on her profile, a new story,
// or a message she sends. Each kind has its own cap, nag interval and checklist.
export const KINDS = ["post", "story", "dm"];

/** Config read from Worker env vars, with defaults. */
export function readConfig(env = {}) {
  const list = (v, d) =>
    (v ?? d)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const kind = (prefix, cap, nag, required) => ({
    cap: num(env[`${prefix}_CAP_MIN`], cap),
    // Nag intervals in minutes; several values alternate by nag_count.
    nag: list(env[`${prefix}_NAG_MIN`], nag).map(Number),
    required: list(env[`${prefix}_REQUIRED`], required),
  });
  return {
    post: kind("POST", 30, "10", "view,like,comment"),
    story: kind("STORY", 10, "5", "watched"),
    dm: kind("DM", 10, "5", "watched,replied"),
  };
}

export function initialState() {
  return {
    state: "locked", // locked | unlocked | session
    reason: null, // post | story | dm | mixed
    kinds: [], // every kind in the current window
    items: [], // [{ id, url }]
    required: [],
    checked: [],
    unlocked_at: null,
    session_started: null,
    cap_minutes: null,
    last_nag: null,
    nag_count: 0,
    last_check: null, // when the Mac checker last checked in
    stale_alerted: false, // already warned that the checker stopped
    seen: [], // ids already used for an unlock, newest last
    log: [], // finished sessions: { reason, items, started, ended, minutes, how }
  };
}

function relock(s, now, how) {
  const minutes =
    s.session_started != null
      ? Math.round(((now - s.session_started) / MINUTE) * 10) / 10
      : 0;
  const entry = {
    reason: s.reason,
    items: s.items.length,
    started: s.session_started,
    ended: now,
    minutes,
    how, // checklist | cap | manual
  };
  return {
    ...initialState(),
    seen: s.seen,
    last_check: s.last_check,
    stale_alerted: s.stale_alerted,
    log: [...s.log, entry].slice(-100),
  };
}

export function minutesLeft(s, now) {
  if (s.state !== "session") return s.state === "unlocked" ? s.cap_minutes : 0;
  const left = s.cap_minutes - (now - s.session_started) / MINUTE;
  return Math.max(0, Math.ceil(left));
}

/** Relock if the session has run past its cap. Safe to call any time. */
export function enforceCap(s, now) {
  if (s.state === "session" && minutesLeft(s, now) <= 0) {
    return relock(s, now, "cap");
  }
  return s;
}

// Kinds in the current window. Older records only have `reason`.
function kindsOf(s) {
  if (s.kinds?.length) return s.kinds;
  return KINDS.includes(s.reason) ? [s.reason] : ["post"];
}

/**
 * New activity from her. Returns { state, added } where added is the number of
 * new items. Items already seen are ignored so repeated checker runs are safe.
 */
export function unlock(s, { reason, items }, cfg, now) {
  if (!KINDS.includes(reason)) {
    throw new Error('reason must be "post", "story" or "dm"');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items must be a non empty array");
  }
  s = enforceCap(s, now);
  const seen = new Set(s.seen);
  const fresh = items
    .filter((it) => it && typeof it.id === "string" && it.id.length > 0)
    .filter((it) => !seen.has(it.id))
    .map((it) => ({
      id: it.id,
      url: typeof it.url === "string" ? it.url : null,
      // Optional display name of who posted or sent it, for push text.
      ...(typeof it.from === "string" && it.from ? { from: it.from } : {}),
    }));
  // Dedupe within the same request too.
  const unique = [...new Map(fresh.map((it) => [it.id, it])).values()];
  if (unique.length === 0) return { state: s, added: 0 };

  const newSeen = [...s.seen, ...unique.map((it) => it.id)].slice(-SEEN_LIMIT);

  if (s.state === "locked") {
    return {
      added: unique.length,
      state: {
        ...s,
        state: "unlocked",
        reason,
        kinds: [reason],
        items: unique,
        required: cfg[reason].required,
        checked: [],
        unlocked_at: now,
        session_started: null,
        cap_minutes: cfg[reason].cap,
        last_nag: null,
        nag_count: 0,
        seen: newSeen,
      },
    };
  }

  // Already open: add the items to the current window. Required actions are
  // the union, and the new thing gets at least its full time from now.
  const kinds = [...new Set([...kindsOf(s), reason])];
  const used = s.session_started != null ? Math.ceil((now - s.session_started) / MINUTE) : 0;
  return {
    added: unique.length,
    state: {
      ...s,
      reason: kinds.length === 1 ? reason : "mixed",
      kinds,
      items: [...s.items, ...unique],
      required: [...new Set([...s.required, ...cfg[reason].required])],
      cap_minutes: Math.max(s.cap_minutes, used + cfg[reason].cap),
      seen: newSeen,
    },
  };
}

function describe(s) {
  const n = s.items.length;
  if (s.reason === "post") return n === 1 ? "her new post" : `her ${n} new posts`;
  if (s.reason === "story") return n === 1 ? "her new story" : `${n} new stories from her`;
  if (s.reason === "dm") return n === 1 ? "her message" : `${n} messages from her`;
  return `${n} new things from her`;
}

/**
 * Called by the Shortcuts gate every time Instagram opens.
 * Returns { state, response } where response is what the gate reads.
 */
export function status(s, now) {
  s = enforceCap(s, now);
  if (s.state === "locked") {
    return {
      state: s,
      response: {
        open: false,
        state: "locked",
        minutes_left: 0,
        message: "Locked. Nothing new from her.",
      },
    };
  }
  if (s.state === "unlocked") {
    s = { ...s, state: "session", session_started: now, last_nag: now };
  }
  const left = minutesLeft(s, now);
  const todo = s.required.filter((a) => !s.checked.includes(a));
  return {
    state: s,
    response: {
      open: true,
      state: s.state,
      minutes_left: left,
      message: `Open for ${describe(s)}. ${left} min left. To do: ${todo.join(", ")}.`,
      items: s.items,
      required: s.required,
      checked: s.checked,
    },
  };
}

/**
 * Record checklist ticks. Relocks when every required action is ticked.
 * Returns { state, done }.
 */
export function check(s, { checked }, now) {
  if (!Array.isArray(checked)) throw new Error("checked must be an array");
  s = enforceCap(s, now);
  if (s.state === "locked") return { state: s, done: true };
  const valid = checked.filter((a) => s.required.includes(a));
  const merged = [...new Set([...s.checked, ...valid])];
  const done = s.required.every((a) => merged.includes(a));
  if (done) {
    // If the app was never opened, count the session from now so the log is sane.
    const started = s.session_started ?? now;
    return { state: relock({ ...s, session_started: started }, now, "checklist"), done: true };
  }
  return { state: { ...s, checked: merged }, done: false };
}

export function forceLock(s, now) {
  if (s.state === "locked") return s;
  return relock(s, now, "manual");
}

// Question asked in a nag for each unticked checklist action.
function ask(action, s) {
  switch (action) {
    case "view":
      return "Seen her post?";
    case "like":
      return "Liked?";
    case "comment":
      return "Commented?";
    case "watched":
      if (s.reason === "story") return "Watched her story?";
      if (s.reason === "dm") return "Seen what she sent?";
      return "Watched everything?";
    case "replied":
      return "Replied?";
    default:
      return `${action}?`;
  }
}

/**
 * Reminder push during a session. Returns { state, message } where message is
 * null when no nag is due. Each kind nags on its own interval; a mixed
 * window uses the shortest one.
 */
export function nag(s, cfg, now) {
  if (s.state !== "session") return { state: s, message: null };
  const interval =
    Math.min(...kindsOf(s).map((k) => cfg[k].nag[s.nag_count % cfg[k].nag.length])) * MINUTE;
  const since = s.last_nag ?? s.session_started;
  if (now - since < interval) return { state: s, message: null };
  const todo = s.required.filter((a) => !s.checked.includes(a));
  const left = minutesLeft(s, now);
  return {
    state: { ...s, last_nag: now, nag_count: s.nag_count + 1 },
    message: {
      title: "Instagram check",
      level: "timeSensitive",
      body: `${todo.map((a) => ask(a, s)).join(" ")} Tick it and close the app. ${left} min left.`,
      checklist: true,
    },
  };
}

/**
 * Final push when a session has just ended through the checklist or the cap.
 * Pass the state before and after a transition. Manual locks stay silent.
 */
export function finalPush(prev, next) {
  if (prev.state === "locked" || next.state !== "locked") return null;
  const how = next.log.at(-1)?.how;
  if (how !== "checklist" && how !== "cap") return null;
  return {
    title: how === "cap" ? "Time is up" : "Checklist done",
    level: "timeSensitive",
    body: how === "cap" ? "Time is up. Instagram is locked again." : "Done. Instagram is locked again.",
    checklist: false,
  };
}

/**
 * Push sent when /unlock adds something, so Rayan knows Instagram is open.
 * Pass the state before and after the unlock plus the added count.
 */
export function unlockPush(prev, next, added, now) {
  if (added <= 0 || next.state === "locked") return null;
  const fresh = next.items.slice(-added);
  const who = fresh.find((it) => it.from)?.from ?? "her";
  let what;
  if (prev.state === "locked") {
    const noun = { post: ["post", "posts"], story: ["story", "stories"], dm: ["message", "messages"] }[
      next.reason
    ];
    what = added === 1 ? `New ${noun[0]} from ${who}.` : `${added} new ${noun[1]} from ${who}.`;
  } else {
    what = `More from ${who}.`;
  }
  const when =
    next.state === "unlocked"
      ? `Your ${next.cap_minutes} minutes start when you open Instagram.`
      : `${minutesLeft(next, now)} min left.`;
  return {
    title: "Instagram unlocked",
    level: "timeSensitive",
    body: `${what} ${when}`,
    checklist: false,
  };
}

const WAITING_AFTER = 60 * MINUTE;
export const STALE_AFTER = 26 * 60 * MINUTE;

/**
 * The Mac checker checked in after a run. Records the time and, if something
 * unlocked earlier is still waiting to be opened, returns a reminder so it
 * is not forgotten. Returns { state, message }.
 */
export function checkIn(s, now) {
  const next = { ...s, last_check: now, stale_alerted: false };
  if (s.state !== "unlocked" || now - s.unlocked_at < WAITING_AFTER) return { state: next, message: null };
  const what = describe(s);
  return {
    state: next,
    message: {
      title: "Still waiting",
      level: "timeSensitive",
      body: `${what[0].toUpperCase()}${what.slice(1)} is still waiting. Your ${s.cap_minutes} minutes start when you open Instagram.`,
      checklist: false,
    },
  };
}

/** Warn once if the checker has not checked in for over a day. */
export function staleCheck(s, now) {
  if (s.last_check == null || s.stale_alerted || now - s.last_check < STALE_AFTER) {
    return { state: s, message: null };
  }
  return {
    state: { ...s, stale_alerted: true },
    message: {
      title: "Checker stopped",
      level: "timeSensitive",
      body: "The Mac checker has not run for over a day, so nothing new can unlock. Open the Mac and check it.",
      checklist: false,
    },
  };
}
