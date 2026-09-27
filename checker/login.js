// One time login. Opens a visible browser at the Instagram login page; Rayan
// logs in himself (the script never sees or types his password). Once logged
// in, the session cookies are saved to checker/session.json (gitignored).

import { chmodSync } from "node:fs";
import { openBrowser, SESSION, log } from "./src/setup.js";

const { browser, context } = await openBrowser({ headless: false });
const page = await context.newPage();
await page.goto("https://www.instagram.com/accounts/login/");
log("Log in to Instagram in the browser window. Waiting up to 10 minutes...");

const deadline = Date.now() + 10 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  const cookies = await context.cookies("https://www.instagram.com");
  if (cookies.some((c) => c.name === "sessionid" && c.value)) {
    ok = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}

if (ok) {
  // Give Instagram a moment to finish setting its cookies, then save.
  await page.waitForTimeout(4000);
  await context.storageState({ path: SESSION });
  chmodSync(SESSION, 0o600);
  log("Logged in. Session saved to checker/session.json. You can close the window.");
} else {
  log("Timed out waiting for login. Nothing saved.");
}
await browser.close();
process.exit(ok ? 0 : 1);
