// Pure state machine for Insta Lock In. No I/O here: every function takes the
// current state plus inputs and returns a new state (and sometimes a response).
// Times are epoch milliseconds so tests can pass a fixed clock.

export const MINUTE = 60 * 1000;
const SEEN_LIMIT = 200;

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
  return {
    postCapMin: num(env.POST_CAP_MIN, 15),
    reelBaseMin: num(env.REEL_BASE_MIN, 10),
    reelPerItemMin: num(env.REEL_PER_ITEM_MIN, 1),
    postRequired: list(env.POST_REQUIRED, "view,like,comment"),
    reelRequired: list(env.REEL_REQUIRED, "watched,replied"),
    // Nag intervals in minutes. Reels alternate between the listed values.
    postNagMin: list(env.POST_NAG_MIN, "5").map(Number),
    reelNagMin: list(env.REEL_NAG_MIN, "2,3").map(Number),
  };
}

export function initialState() {
  return {
    state: "locked", // locked | unlocked | session
    reason: null, // post | reels
    items: [], // [{ id, url }]
    required: [],
    checked: [],
    unlocked_at: null,
    session_started: null,
    cap_minutes: null,
    last_nag: null,
    nag_count: 0,
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

function capFor(reason, itemCount, cfg) {
  return reason === "post"
    ? cfg.postCapMin
    : cfg.reelBaseMin + cfg.reelPerItemMin * itemCount;
}

/**
 * New activity from her. Returns { state, added } where added is the number of
 * new items. Items already seen are ignored so repeated checker runs are safe.
 */
export function unlock(s, { reason, items }, cfg, now) {
  if (reason !== "post" && reason !== "reels") {
    throw new Error('reason must be "post" or "reels"');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items must be a non empty array");
  }
  s = enforceCap(s, now);
  const seen = new Set(s.seen);
  const fresh = items
    .filter((it) => it && typeof it.id === "string" && it.id.length > 0)
    .filter((it) => !seen.has(it.id))
    .map((it) => ({ id: it.id, url: typeof it.url === "string" ? it.url : null }));
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
        items: unique,
        required: reason === "post" ? cfg.postRequired : cfg.reelRequired,
        checked: [],
        unlocked_at: now,
        session_started: null,
        cap_minutes: capFor(reason, unique.length, cfg),
        last_nag: null,
        nag_count: 0,
        seen: newSeen,
      },
    };
  }

  // Already open: add the items to the current window. A post plus Reels
  // becomes a combined window; required actions are the union.
  const allItems = [...s.items, ...unique];
  const mixed = s.reason !== reason;
  const required = mixed
    ? [...new Set([...cfg.postRequired, ...cfg.reelRequired])]
    : s.required;
  const extra = reason === "post" ? cfg.postCapMin : cfg.reelPerItemMin * unique.length;
  return {
    added: unique.length,
    state: {
      ...s,
      reason: mixed ? "mixed" : s.reason,
      items: allItems,
      required,
      cap_minutes: s.cap_minutes + extra,
      seen: newSeen,
    },
  };
}

function describe(s) {
  const n = s.items.length;
  if (s.reason === "post") return n === 1 ? "her new post" : `her ${n} new posts`;
  if (s.reason === "reels") return n === 1 ? "1 Reel from her" : `${n} Reels from her`;
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
  const reels = s.items.length;
  switch (action) {
    case "view":
      return "Seen her post?";
    case "like":
      return "Liked?";
    case "comment":
      return "Commented?";
    case "watched":
      return reels === 1 ? "Watched the Reel?" : `Watched all ${reels} Reels?`;
    case "replied":
      return "Replied?";
    default:
      return `${action}?`;
  }
}

/**
 * Reminder push during a session. Returns { state, message } where message is
 * null when no nag is due. Posts nag every POST_NAG_MIN; Reels and mixed
 * windows cycle through REEL_NAG_MIN by nag_count.
 */
export function nag(s, cfg, now) {
  if (s.state !== "session") return { state: s, message: null };
  const steps = s.reason === "post" ? cfg.postNagMin : cfg.reelNagMin;
  const interval = steps[s.nag_count % steps.length] * MINUTE;
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
    body: "Done. Delete Instagram now.",
    checklist: false,
  };
}
