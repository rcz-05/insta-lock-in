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
    // DM_HANDLES, or DM_HANDLE from older files; either takes a comma list.
    dmHandles: handles(env.DM_HANDLES ?? env.DM_HANDLE),
  };
}

// Instagram is blocked for every browser on this Mac through /etc/hosts
// (block-web.sh). The checker looks the address up itself over DNS over
// HTTPS and hands it straight to its own browser, so only the checker gets
// through. If the lookup fails it falls back to normal DNS.
const BLOCKED_HOSTS = ["www.instagram.com", "instagram.com"];

async function lookup(name) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(8000),
  });
  const a = (await r.json()).Answer?.filter((x) => x.type === 1).map((x) => x.data) ?? [];
  if (!a.length) throw new Error(`no address for ${name}`);
  return a[0];
}

export async function resolverRules() {
  try {
    const rules = [];
    for (const host of BLOCKED_HOSTS) rules.push(`MAP ${host} ${await lookup(host)}`);
    return rules.join(", ");
  } catch {
    return null;
  }
}

// Look like a normal desktop Chrome, not "HeadlessChrome".
export async function openBrowser({ headless }) {
  const rules = await resolverRules();
  const browser = await chromium.launch({ headless, args: rules ? [`--host-resolver-rules=${rules}`] : [] });
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
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // The log still has it.
  }
}

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const pause = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
