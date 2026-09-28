// One checker run: look at the watched accounts, find what is new since last
// time, and ask the Worker to unlock. `--dry-run` prints what it would unlock
// and saves nothing. `--dm-only` skips profiles and only reads the inbox list.
//
// launchd starts this every hour. A scheduled run does real work only when
// the last completed run was about 12 hours ago, so Instagram sees at most
// two checks a day, but a check missed while the Mac was off, asleep or
// offline happens within an hour of it being back. `--now` skips the wait.

import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from "node:fs";
import { loadConfig, openBrowser, alert, log, pause, SESSION, STATE } from "./src/setup.js";
import { emptyState, diff, unlockBodies } from "./src/detect.js";
import { profile, inbox, messagesFrom, LoggedOut, RateLimited } from "./src/instagram.js";

const dryRun = process.argv.includes("--dry-run");
const dmOnly = process.argv.includes("--dm-only");
const manual = dryRun || dmOnly || process.argv.includes("--now");
const GAP = (12 * 60 - 10) * 60 * 1000;

// Never hang: launchd will not start a new run while this one is alive, so a
// stalled connection would otherwise block every later check.
setTimeout(() => {
  log("run took over 15 minutes; giving up so the next hour can retry");
  process.exit(1);
}, 15 * 60 * 1000).unref();

// Write through a temp file so a crash or power loss mid write never leaves
// a half written file behind.
function saveJson(path, data) {
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
const cfg = loadConfig();
if (!existsSync(SESSION)) {
  log("No session yet. Run: npm run login");
  process.exit(2);
}

let state = emptyState();
try {
  if (existsSync(STATE)) state = JSON.parse(readFileSync(STATE, "utf8"));
} catch {
  // Unreadable memory: start over. The first run only records a baseline,
  // so this can never unlock something old.
  log("state.json unreadable; starting a fresh baseline");
}
if (!manual && state.last_run && Date.now() - state.last_run < GAP) process.exit(0);
const found = []; // [{ kind, handle, items }]
const problems = []; // things Rayan should hear about
const now = Date.now();

function track(kind, handle, items) {
  const r = diff(state, `${kind}:${handle}`, items, now);
  state = r.state;
  if (r.fresh.length) found.push({ kind, handle, items: r.fresh });
  log(`${kind} @${handle}: ${items.length} seen, ${r.fresh.length} new`);
}

const { browser, context } = await openBrowser({ headless: true });
let exitCode = 0;
let reached = false; // got through to Instagram, so this run counts
try {
  const page = await context.newPage();
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  reached = true;
  if (/\/accounts\/login|\/challenge/.test(page.url())) throw new LoggedOut("Instagram wants a login or a security check");

  // Every account we need a profile for, in random order, spaced out.
  const accounts = dmOnly ? [] : [...new Set([...cfg.postHandles, ...cfg.storyHandles])].sort(() => Math.random() - 0.5);
  for (const handle of accounts) {
    // Spaced out like someone tapping through a few profiles.
    await pause(15000, 45000);
    try {
      const p = await profile(page, handle);
      // An account that had posts suddenly showing none (liked or not)
      // usually means Instagram changed its page, not that all were deleted.
      if (p.postCount === 0 && state.baselines[`post:${handle}`]?.ids.length > 0) {
        problems.push("A profile that had posts now shows none, so Instagram may have changed its page.");
      }
      if (cfg.postHandles.includes(handle)) track("post", handle, p.posts);
      if (cfg.storyHandles.includes(handle)) track("story", handle, p.stories);
    } catch (err) {
      if (err instanceof LoggedOut) throw err;
      if (err instanceof RateLimited) {
        // Stop at once; pushing on is what gets accounts flagged.
        log(`${err.message}; stopping this run early`);
        problems.push("Instagram asked the checker to slow down, so it stopped early.");
        exitCode = 1;
        break;
      }
      log(`skipped @${handle}: ${err.message}`);
      problems.push(`Could not read a profile (${err.message.slice(0, 80)}).`);
      exitCode = 1;
    }
  }

  if (cfg.dmHandles.length) {
    await pause(3000, 8000);
    const box = await inbox(page);
    for (const handle of cfg.dmHandles) track("dm", handle, messagesFrom(box, handle));
  }

  // Keep the session fresh for next time.
  if (!dryRun) {
    await context.storageState({ path: `${SESSION}.tmp` });
    chmodSync(`${SESSION}.tmp`, 0o600);
    renameSync(`${SESSION}.tmp`, SESSION);
  }
} catch (err) {
  if (err instanceof LoggedOut) {
    log(`Instagram session expired: ${err.message}`);
    if (!dryRun) await alert(cfg, "Checker logged out", "Instagram logged the checker out or wants a security check, so nothing can unlock. On the Mac, open Terminal and run: cd ~/Documents/insta-lock-in/checker && npm run login");
    exitCode = 3;
  } else {
    log(`run failed: ${err.stack ?? err.message}`);
    if (reached) problems.push(`The check failed partway (${String(err.message).slice(0, 80)}).`);
    exitCode = 1;
  }
} finally {
  await browser.close();
}

// A run that reached Instagram counts, even a logged out one, so problems
// are reported every 12 hours rather than every hour. A run with no
// internet does not count and is retried next hour.
// A messages only run saves what it saw but is not the 12 hour check.
const markRun = () => {
  if (!reached || dryRun) return;
  if (!dmOnly) state.last_run = now;
  saveJson(STATE, state);
};
if (exitCode === 3) {
  markRun();
  process.exit(exitCode);
}

const bodies = unlockBodies(found);
if (dryRun) {
  log(`dry run: would unlock ${JSON.stringify(bodies)}`);
  process.exit(exitCode);
}

// Only remember new items once the Worker has them, so a failed unlock retries.
for (const body of bodies) {
  const r = await fetch(`${cfg.workerUrl}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-token": cfg.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  }).catch((err) => ({ ok: false, status: err.message }));
  if (!r.ok) {
    log(`unlock failed for ${body.reason}: ${r.status}`);
    process.exit(1);
  }
  log(`unlocked ${body.reason}: ${JSON.stringify(await r.json())}`);
}
markRun();

// Check in so the Worker knows the checker is alive and can remind about
// anything unlocked earlier that is still waiting to be opened.
const ping = await fetch(`${cfg.workerUrl}/ping`, {
  method: "POST",
  headers: { "x-token": cfg.token },
  signal: AbortSignal.timeout(20000),
})
  .then((r) => r.json())
  .catch((err) => ({ error: err.message }));
log(`check in: ${JSON.stringify(ping)}`);
if (problems.length) {
  // Deduplicated, so eight failed profiles read as one line.
  const text = [...new Set(problems)].join(" ");
  await alert(cfg, "Checker needs attention", `${text} It will try again in about 12 hours. If this keeps happening, look at checker.log on the Mac.`);
}
log(bodies.length ? "done, unlocked" : "done, nothing new");
process.exit(exitCode);
