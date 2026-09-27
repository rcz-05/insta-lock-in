// Shared setup for the checker scripts: paths, config, browser, and pushes.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { parseEnv, handles } from "./detect.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
export const SESSION = join(ROOT, "session.json");
export const STATE = join(ROOT, "state.json");
const SECRETS = join(ROOT, "..", ".secrets");

const secret = (name) => readFileSync(join(SECRETS, name), "utf8").trim();

export function loadConfig() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) throw new Error("checker/.env is missing; copy .env.example and fill it in");
  const env = parseEnv(readFileSync(envPath, "utf8"));
  return {
    workerUrl: (env.WORKER_URL || "").replace(/\/+$/, ""),
    token: secret("token"),
    barkKey: existsSync(join(SECRETS, "bark_key")) ? secret("bark_key") : null,
    postHandles: handles(env.POST_HANDLES),
    storyHandles: handles(env.STORY_HANDLES),
    dmHandle: handles(env.DM_HANDLE)[0] ?? null,
  };
}

// Look like a normal desktop Chrome, not "HeadlessChrome".
export async function openBrowser({ headless }) {
  const browser = await chromium.launch({ headless });
  const version = browser.version();
  const context = await browser.newContext({
    storageState: existsSync(SESSION) ? SESSION : undefined,
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    locale: "en-US",
    viewport: { width: 1280, height: 860 },
  });
  return { browser, context };
}

/** Push straight to Rayan's phone, for checker problems the Worker cannot see. */
export async function alert(cfg, title, body) {
  if (!cfg.barkKey) return;
  try {
    await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_key: cfg.barkKey, title, body, group: "insta-lock-in", level: "timeSensitive" }),
    });
  } catch {
    // The log still has it.
  }
}

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const pause = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
