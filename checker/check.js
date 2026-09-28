// One checker run: look at the watched accounts, find what is new since last
// time, and ask the Worker to unlock. `--dry-run` prints what it would unlock
// and saves nothing. `--dm-only` skips profiles and only reads the inbox list.

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { loadConfig, openBrowser, alert, log, pause, SESSION, STATE } from "./src/setup.js";
import { emptyState, diff, unlockBodies } from "./src/detect.js";
import { profile, inbox, messagesFrom, LoggedOut, RateLimited } from "./src/instagram.js";

const dryRun = process.argv.includes("--dry-run");
const dmOnly = process.argv.includes("--dm-only");
const cfg = loadConfig();
if (!existsSync(SESSION)) {
  log("No session yet. Run: npm run login");
  process.exit(2);
}

let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : emptyState();
const found = []; // [{ kind, handle, items }]
const now = Date.now();

function track(kind, handle, items) {
  const r = diff(state, `${kind}:${handle}`, items, now);
  state = r.state;
  if (r.fresh.length) found.push({ kind, handle, items: r.fresh });
  log(`${kind} @${handle}: ${items.length} seen, ${r.fresh.length} new`);
}

const { browser, context } = await openBrowser({ headless: true });
let exitCode = 0;
try {
  const page = await context.newPage();
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  if (page.url().includes("/accounts/login")) throw new LoggedOut("redirected to login");

  // Every account we need a profile for, in random order, spaced out.
  const accounts = dmOnly ? [] : [...new Set([...cfg.postHandles, ...cfg.storyHandles])].sort(() => Math.random() - 0.5);
  for (const handle of accounts) {
    // Spaced out like someone tapping through a few profiles.
    await pause(15000, 45000);
    try {
      const p = await profile(page, handle);
      if (cfg.postHandles.includes(handle)) track("post", handle, p.posts);
      if (cfg.storyHandles.includes(handle)) track("story", handle, p.stories);
    } catch (err) {
      if (err instanceof LoggedOut) throw err;
      if (err instanceof RateLimited) {
        // Stop at once; pushing on is what gets accounts flagged.
        log(`${err.message}; stopping this run early`);
        exitCode = 1;
        break;
      }
      log(`skipped @${handle}: ${err.message}`);
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
    await context.storageState({ path: SESSION });
    chmodSync(SESSION, 0o600);
  }
} catch (err) {
  if (err instanceof LoggedOut) {
    log(`Instagram session expired: ${err.message}`);
    if (!dryRun) await alert(cfg, "Checker logged out", "Instagram logged the checker out. Run npm run login on the Mac.");
    exitCode = 3;
  } else {
    log(`run failed: ${err.stack ?? err.message}`);
    exitCode = 1;
  }
} finally {
  await browser.close();
}

if (exitCode === 3) process.exit(exitCode);

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
  }).catch((err) => ({ ok: false, status: err.message }));
  if (!r.ok) {
    log(`unlock failed for ${body.reason}: ${r.status}`);
    process.exit(1);
  }
  log(`unlocked ${body.reason}: ${JSON.stringify(await r.json())}`);
}
writeFileSync(STATE, JSON.stringify(state, null, 2));

// Check in so the Worker knows the checker is alive and can remind about
// anything unlocked earlier that is still waiting to be opened.
const ping = await fetch(`${cfg.workerUrl}/ping`, { method: "POST", headers: { "x-token": cfg.token } })
  .then((r) => r.json())
  .catch((err) => ({ error: err.message }));
log(`check in: ${JSON.stringify(ping)}`);
log(bodies.length ? "done, unlocked" : "done, nothing new");
process.exit(exitCode);
