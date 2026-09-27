// Checklist page served at GET /checklist. Pure: takes the state and returns
// HTML. Reading the page never starts the session clock; only the gate does.

import { minutesLeft } from "./logic.js";

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function label(action, s) {
  switch (action) {
    case "view":
      return "Seen the post";
    case "like":
      return "Liked it";
    case "comment":
      return "Commented";
    case "watched":
      if (s.reason === "story") return "Watched the story";
      if (s.reason === "dm") return "Saw what she sent";
      return "Watched everything";
    case "replied":
      return "Replied";
    default:
      return action;
  }
}

const KIND_NAME = { post: "Post", story: "Story", dm: "Message" };

function itemList(s) {
  const rows = s.items.map((it, i) => {
    const name = `${KIND_NAME[s.reason] ?? "New"} ${s.items.length > 1 ? i + 1 : ""}`.trim();
    const who = it.from ? ` from ${esc(it.from)}` : "";
    const text = `${name}${who}`;
    return it.url && /^https:\/\//.test(it.url)
      ? `<li><a href="${esc(it.url)}">${text}</a></li>`
      : `<li>${text}</li>`;
  });
  return `<ul class="items">${rows.join("")}</ul>`;
}

function body(s, now) {
  if (s.state === "locked") {
    return `<h1>All done</h1><p class="lead">Instagram is locked. Nothing new yet.</p>`;
  }
  const time =
    s.state === "unlocked"
      ? `Your ${s.cap_minutes} minutes start when you open Instagram.`
      : `${minutesLeft(s, now)} min left.`;
  const boxes = s.required
    .map((a) => {
      const done = s.checked.includes(a);
      return `<label class="box${done ? " done" : ""}"><input type="checkbox" name="checked" value="${esc(a)}"${
        done ? " checked disabled" : ""
      }><span>${esc(label(a, s))}</span></label>`;
    })
    .join("");
  return `<h1>Instagram check</h1>
<p class="lead">${esc(time)}</p>
${itemList(s)}
<form id="f">${boxes}<button type="submit">Done</button></form>
<p id="msg" class="lead" role="status"></p>`;
}

const SCRIPT = `
const f = document.getElementById("f");
if (f) f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  const checked = [...f.querySelectorAll("input:checked")].map((i) => i.value);
  const t = new URLSearchParams(location.search).get("t") || "";
  msg.textContent = "Saving...";
  try {
    const r = await fetch("/done", {
      method: "POST",
      headers: { "content-type": "application/json", "x-token": t },
      body: JSON.stringify({ checked }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "failed");
    if (d.done) {
      document.querySelector("main").innerHTML =
        "<h1>All done</h1><p class='lead'>Instagram is locked again. Close the app.</p>";
    } else {
      f.querySelectorAll("input:checked").forEach((i) => { i.disabled = true; i.parentElement.classList.add("done"); });
      msg.textContent = "Saved. Tick the rest when you have done them.";
    }
  } catch (err) {
    msg.textContent = "Could not save. Check your connection and try again.";
  }
});
`;

export function renderChecklist(s, now) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Instagram check</title>
<style>
:root { --bg: #f6f6f4; --fg: #1a1a1a; --muted: #666; --card: #fff; --line: #ddd; --accent: #d9453b; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111; --fg: #f1f1f1; --muted: #9a9a9a; --card: #1c1c1e; --line: #333; --accent: #ff5a4f; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.45 -apple-system, system-ui, sans-serif; }
main { max-width: 480px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 28px; margin: 0 0 6px; }
.lead { color: var(--muted); margin: 0 0 20px; }
.items { list-style: none; padding: 0; margin: 0 0 20px; }
.items li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.items a { color: var(--accent); text-decoration: none; }
.box { display: flex; align-items: center; gap: 14px; background: var(--card); border: 1px solid var(--line);
  border-radius: 14px; padding: 16px; margin-bottom: 10px; font-size: 19px; }
.box input { width: 26px; height: 26px; accent-color: var(--accent); }
.box.done span { color: var(--muted); text-decoration: line-through; }
button { width: 100%; margin-top: 10px; padding: 16px; font-size: 19px; font-weight: 600; border: 0;
  border-radius: 14px; background: var(--accent); color: #fff; }
</style>
</head>
<body>
<main>
${body(s, now)}
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
