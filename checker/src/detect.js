// Pure logic for the checker: decide what is new since the last run. No I/O.
//
// The checker keeps a baseline per source ("post:handle", "story:handle",
// "dm:handle"): when it started watching, and the ids it has already seen.
// The first time a source is seen nothing unlocks; everything that exists then
// becomes the baseline. After that, an item is new only if its id is unknown
// AND it was created after watching began, so pinned or old posts that scroll
// back into view never unlock.

const KEEP_IDS = 100;

export function emptyState() {
  return { baselines: {} };
}

/**
 * items: [{ id, ts, url }] with ts in epoch ms. Returns { fresh, state }.
 * Never mutates the input state.
 */
export function diff(state, key, items, now) {
  const base = state.baselines[key];
  if (!base) {
    return {
      fresh: [],
      state: {
        ...state,
        baselines: { ...state.baselines, [key]: { since: now, ids: items.map((it) => it.id).slice(0, KEEP_IDS) } },
      },
    };
  }
  const known = new Set(base.ids);
  const fresh = items.filter((it) => !known.has(it.id) && it.ts > base.since);
  const ids = [...new Set([...items.map((it) => it.id), ...base.ids])].slice(0, KEEP_IDS);
  return {
    fresh,
    state: { ...state, baselines: { ...state.baselines, [key]: { since: base.since, ids } } },
  };
}

/** Turn fresh items into /unlock bodies, one per kind, with `from` set. */
export function unlockBodies(found) {
  const byKind = new Map();
  for (const { kind, handle, items } of found) {
    for (const it of items) {
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push({ id: it.id, url: it.url ?? undefined, from: handle });
    }
  }
  return [...byKind].map(([reason, items]) => ({ reason, items }));
}

/** Parse a tiny KEY=value file. Blank lines and # comments are ignored. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Handles from a comma list: trimmed, lowercased, no @, no duplicates. */
export function handles(v) {
  return [...new Set((v ?? "").split(",").map((h) => h.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
}
