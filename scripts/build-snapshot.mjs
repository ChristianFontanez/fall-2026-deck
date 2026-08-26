// Builds a read-only snapshot.html + data/canvas.json for the Fall 2026 Command Deck.
// Runs in GitHub Actions. No npm dependencies (Node 20+, global fetch).
//
// Env:
//   VAULT_DIR   path to a checkout of the Obsidian vault (default: "vault")
//   CANVAS_ICS  optional Canvas calendar-feed URL (webcal/https .ics) to overlay graded deadlines
//   OUT_DIR     where to write outputs (default: ".")

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const VAULT_DIR = process.env.VAULT_DIR || "vault";
const OUT_DIR = process.env.OUT_DIR || ".";
const CANVAS_ICS = process.env.CANVAS_ICS || "";
const DIR = "School/Fall 2026";
const EXCLUDE = new Set(["Fall 2026 Dashboard.md"]);

const COURSES = {
  cms450: { code: "CMS 450", name: "Computer Networks", num: "94295", hue: "#0891b2" },
  mat219: { code: "MAT 219", name: "Probability & Statistics", num: "94468", hue: "#db2777" },
  cms270: { code: "CMS 270", name: "Object-Oriented Design", num: "94291", hue: "#7c3aed" },
};
const NUM_TO_KEY = { "94295": "cms450", "94468": "mat219", "94291": "cms270" };
const RAIL_ORDER = ["cms450", "cms270", "mat219"];

const TASK_RE = /^(\s*)[-*]\s*\[(.)\]\s*(.+?)\s*$/;
const EMOJI = /[\u{1F4C5}✅⏳\u{1F6EB}➕❌\u{1F501}⏫\u{1F53C}\u{1F53D}\u{1F53A}]/gu;

function walk(dir) {
  let out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (e.endsWith(".md") && !EXCLUDE.has(e)) out.push(p);
  }
  return out;
}

function parseFile(relPath, text) {
  const out = [];
  const lines = text.split("\n");
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence || /^\s*>/.test(line)) return;
    const m = line.match(TASK_RE);
    if (!m) return;
    const sc = m[2], raw = m[3];
    const dm = raw.match(/\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})/u);
    const due = dm ? dm[1] : null;
    const tags = (raw.match(/#[A-Za-z0-9_\-\/]+/g) || []).map((t) => t.slice(1).toLowerCase());
    let courseKey = null;
    for (const k of ["cms450", "mat219", "cms270"]) if (tags.includes(k)) courseKey = k;
    const title = raw.replace(new RegExp(EMOJI.source + "\\s*\\d{4}-\\d{2}-\\d{2}", "gu"), "")
      .replace(EMOJI, "").replace(/#[A-Za-z0-9_\-\/]+/g, "").replace(/\s+/g, " ").trim();
    const status = (sc === "x" || sc === "X" || sc === "-") ? "done" : (sc === "/" ? "inprogress" : "todo");
    const cidTag = tags.find((t) => /^cid\d+$/.test(t));
    const assignmentId = cidTag ? cidTag.slice(3) : null;
    out.push({ file: relPath.split("/").pop().replace(/\.md$/, ""), title, due, status, courseKey, isExam: tags.includes("exam"), assignmentId });
  });
  return out;
}

// ---- Canvas ICS ----
function unfold(ics) { return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, ""); }
function parseICS(ics) {
  const events = [];
  const blocks = unfold(ics).split("BEGIN:VEVENT").slice(1);
  for (const b of blocks) {
    const body = b.split("END:VEVENT")[0];
    const sum = (body.match(/\nSUMMARY(?:;[^:]*)?:(.*)/) || [])[1];
    const dt = (body.match(/\nDT(?:START|END)(?:;[^:]*)?:([0-9TZ]+)/) || [])[1];
    if (!sum || !dt) continue;
    let iso = null, allDay = false;
    if (/^\d{8}$/.test(dt)) { iso = `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}`; allDay = true; }
    else { const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/); if (m) iso = `${m[1]}-${m[2]}-${m[3]}`; }
    if (!iso) continue;
    events.push({ summary: sum.trim().replace(/\\,/g, ",").replace(/\\;/g, ";"), due: iso, allDay });
  }
  return events;
}
function canvasCourse(summary) {
  const numM = summary.match(/\((\d{4,6})\)/);
  if (numM && NUM_TO_KEY[numM[1]]) return NUM_TO_KEY[numM[1]];
  const s = summary.toLowerCase();
  if (/computer networks/.test(s)) return "cms450";
  if (/probability|statistic/.test(s)) return "mat219";
  if (/object[- ]orient/.test(s)) return "cms270";
  return null; // excludes Internship (94810) and anything else
}
async function loadCanvas() {
  if (!CANVAS_ICS) return [];
  const url = CANVAS_ICS.replace(/^webcal:/, "https:");
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) { console.log("Canvas ICS fetch failed:", r.status); return []; }
    const ics = await r.text();
    const out = [];
    for (const ev of parseICS(ics)) {
      const key = canvasCourse(ev.summary);
      if (!key) continue;
      const title = ev.summary.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
      out.push({ title, code: COURSES[key].code, courseKey: key, due: ev.due, allDay: ev.allDay });
    }
    out.sort((a, b) => (a.due < b.due ? -1 : 1));
    console.log(`Canvas: ${out.length} assignments for tracked courses`);
    return out;
  } catch (e) { console.log("Canvas ICS error:", e.message); return []; }
}

// ---- date helpers (UTC-safe, snapshot is a point-in-time) ----
function today() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function diffDays(iso) { if (!iso) return null; const d = new Date(iso + "T00:00:00Z"); return Math.round((d - today()) / 86400000); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function relLabel(d) { return d === 0 ? "today" : d === 1 ? "tomorrow" : d === -1 ? "yesterday" : d < 0 ? Math.abs(d) + "d ago" : "in " + d + "d"; }

// ---- render snapshot.html ----
function render(tasks, canvas, builtAt) {
  const open = tasks.filter((t) => !t.isExam);
  const exams = tasks.filter((t) => t.isExam && t.status !== "done")
    .sort((a, b) => (a.due || "9") < (b.due || "9") ? -1 : 1);
  const hue = (k) => (k && COURSES[k] ? COURSES[k].hue : "#4f46e5");

  const rails = RAIL_ORDER.map((k) => {
    const c = COURSES[k];
    const list = open.filter((t) => t.courseKey === k);
    const total = list.length, done = list.filter((t) => t.status === "done").length;
    const over = list.filter((t) => t.status !== "done" && diffDays(t.due) !== null && diffDays(t.due) < 0).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="rail" style="--rc:${c.hue}"><div class="rh"><b>${c.code}</b> <span>${esc(c.name)}</span><em>${done}/${total}</em></div><div class="bar"><i style="width:${pct}%"></i></div><div class="rm"><span>${pct}% done</span>${over ? `<span class="crit">${over} overdue</span>` : "<span>on track</span>"}</div></div>`;
  }).join("");

  const codeToKey = (m) => (m === "CMS 450" ? "cms450" : m === "MAT 219" ? "mat219" : m === "CMS 270" ? "cms270" : null);
  const examHTML = exams.length ? exams.map((t) => {
    const m = (t.title.match(/(CMS 450|MAT 219|CMS 270)/) || [])[1];
    const key = t.courseKey || codeToKey(m);
    const code = m || (key && COURSES[key] ? COURSES[key].code : "Exam");
    const name = t.title.replace(/^(CMS 450|MAT 219|CMS 270)\s*[—\-·]*\s*/, "");
    const d = diffDays(t.due);
    const cnt = t.due ? (d === 0 ? '<span class="cnt urg">today</span>' : d < 0 ? '<span class="cnt">passed</span>' : `<span class="cnt ${d <= 3 ? "urg" : d <= 10 ? "soon" : ""}">${d}d</span>`) : '<span class="tbc">TBC</span>';
    const date = t.due ? new Date(t.due + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "confirm date";
    return `<div class="chip2" style="--ec:${hue(key)}">${cnt}<div class="c1">${esc(code)}</div><div class="c2">${esc(name)}</div><div class="c3">${esc(date)}</div></div>`;
  }).join("") : '<div class="empty">No exams tracked yet.</div>';

  const canvasUpcoming = canvas.filter((c) => diffDays(c.due) >= -1).slice(0, 16);
  const canvasHTML = canvasUpcoming.length ? canvasUpcoming.map((c) => {
    const d = diffDays(c.due);
    const cls = d < 0 ? "over" : d <= 2 ? "soon" : "";
    const date = new Date(c.due + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return `<div class="chip2" style="--ec:${hue(c.courseKey)}"><div class="c1">${esc(c.code)}</div><div class="c2">${esc(c.title)}</div><div class="c3 ${cls}">${esc(date)} · ${esc(relLabel(d))}</div></div>`;
  }).join("") : '<div class="empty">No upcoming Canvas assignments (or Canvas feed not configured).</div>';

  const cols = { todo: [], inprogress: [], done: [] };
  open.forEach((t) => (cols[t.status] || cols.todo).push(t));
  const colName = { todo: "To Do", inprogress: "In Progress", done: "Done" };
  const board = ["todo", "inprogress", "done"].map((k) => {
    const list = cols[k].sort((a, b) => {
      const da = a.due || "9999", db = b.due || "9999";
      return k === "done" ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
    });
    const cards = list.length ? list.map((t) => {
      const d = diffDays(t.due);
      const dcls = t.status === "done" ? "done" : d == null ? "" : d < 0 ? "over" : d <= 2 ? "soon" : "";
      const due = t.status === "done" ? "✓ done" : t.due ? relLabel(d) : "no date";
      return `<div class="card" style="--cc:${hue(t.courseKey)}"><div class="ct"><span class="cc">${esc(t.courseKey ? COURSES[t.courseKey].code : "Note")}</span><span class="cf">${esc(t.file)}</span></div><div class="cti">${esc(t.title)}</div><div class="cd ${dcls}">${esc(due)}</div></div>`;
    }).join("") : `<div class="empty">${k === "done" ? "Nothing finished yet" : k === "inprogress" ? "Nothing in progress" : "All clear"}</div>`;
    return `<div class="col"><div class="colh"><span class="cdot ${k}"></span>${colName[k]}<em>${list.length}</em></div><div class="colb">${cards}</div></div>`;
  }).join("");

  const total = open.length, done = open.filter((t) => t.status === "done").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const stamp = builtAt.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fall 2026 Command Deck — snapshot</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#f4f6f9;--surface:#fff;--surface-2:#eef1f5;--ink:#191d26;--muted:#6a7382;--line:#e2e6ec;--line-s:#cdd3dc;--accent:#4f46e5;--good:#1f9d63;--warn:#c07d0a;--crit:#d43a3a;--shadow:0 1px 2px rgba(20,26,38,.06),0 4px 14px rgba(20,26,38,.05);--r:12px}
@media (prefers-color-scheme:dark){:root{--bg:#0f1319;--surface:#171c25;--surface-2:#1e2530;--ink:#e8ecf2;--muted:#8b95a4;--line:#262d3a;--line-s:#333c4b;--accent:#8b93ff;--good:#47c78a;--warn:#e0a53b;--crit:#f0736f;--shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.3)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;padding-bottom:48px}
h1,h2{font-family:"Bricolage Grotesque","IBM Plex Sans",sans-serif;margin:0}.mono,.rh em,.cnt,.c3,.cd,.colh em{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.wrap{max-width:1220px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--surface) 90%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.hin{max-width:1220px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
h1{font-size:20px;font-weight:800;letter-spacing:-.02em;margin-right:auto}.sub{font-size:12px;color:var(--muted);font-weight:500}
.ro{display:flex;align-items:center;gap:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:12px;color:var(--muted);font-weight:600}
.ro b{color:var(--good);font-size:14px}
.snap{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 12px}
.sh{display:flex;align-items:baseline;gap:10px;margin:24px 0 12px}.sh h2{font-size:15px;font-weight:700}.sh .hint{font-size:12px;color:var(--muted)}
.rails{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px}
.rail{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:13px 15px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.rail::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--rc)}
.rh{display:flex;align-items:baseline;gap:6px}.rh b{font-size:14px}.rh span{font-size:11.5px;color:var(--muted)}.rh em{margin-left:auto;font-style:normal;font-size:12px;font-weight:600}
.bar{height:7px;border-radius:999px;background:var(--surface-2);margin-top:10px;overflow:hidden}.bar i{display:block;height:100%;background:var(--rc);border-radius:999px}
.rm{display:flex;gap:12px;margin-top:9px;font-size:11.5px;color:var(--muted)}.rm .crit{color:var(--crit);font-weight:600}
.strip{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}
.chip2{flex:0 0 auto;min-width:168px;background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--ec);border-radius:var(--r);padding:11px 13px;box-shadow:var(--shadow);position:relative}
.chip2 .c1{font-size:11px;font-weight:700;color:var(--ec)}.chip2 .c2{font-size:12.5px;margin-top:2px;padding-right:30px}.chip2 .c3{font-size:11px;color:var(--muted);margin-top:7px}.chip2 .c3.soon{color:var(--warn)}.chip2 .c3.over{color:var(--crit)}
.cnt{position:absolute;top:10px;right:12px;font-size:14px;font-weight:700;color:var(--muted)}.cnt.soon{color:var(--warn)}.cnt.urg{color:var(--crit)}.tbc{position:absolute;top:10px;right:12px;font-size:11px;color:var(--warn);font-weight:600}
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:12px}
.col{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r);padding:10px}
.colh{display:flex;align-items:center;gap:8px;padding:4px 6px 10px;font-weight:700;font-size:13.5px}.colh em{margin-left:auto;font-style:normal;font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:1px 9px}
.cdot{width:9px;height:9px;border-radius:3px}.cdot.todo{background:var(--muted)}.cdot.inprogress{background:var(--accent)}.cdot.done{background:var(--good)}
.colb{display:flex;flex-direction:column;gap:9px}
.card{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--cc);border-radius:8px;padding:11px 12px;box-shadow:var(--shadow)}
.ct{display:flex;gap:7px;align-items:center;margin-bottom:5px}.cc{font-size:11px;font-weight:700;color:var(--cc)}.cf{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:0 5px;font-weight:600}
.cti{font-size:13.5px;font-weight:500}.col:last-child .cti,.done .cti{}.cd{font-size:11.5px;font-weight:600;color:var(--muted);margin-top:8px}.cd.soon{color:var(--warn)}.cd.over{color:var(--crit)}.cd.done{color:var(--good)}
.empty{font-size:12.5px;color:var(--muted);opacity:.7;text-align:center;padding:18px 8px}
footer{max-width:1220px;margin:28px auto 0;padding:16px 20px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px;display:flex;gap:14px;flex-wrap:wrap}
@media (max-width:860px){.rails,.board{grid-template-columns:1fr}}
</style></head><body>
<header><div class="hin"><h1>Fall 2026 Command Deck</h1><div class="ro"><span>Done</span> <b>${pct}%</b></div><span class="snap">Read-only snapshot · ${esc(stamp)}</span></div></header>
<main class="wrap">
<section class="rails">${rails}</section>
<div class="sh"><h2>Exams &amp; finals</h2><span class="hint">countdown</span></div><section class="strip">${examHTML}</section>
<div class="sh"><h2>Canvas deadlines</h2><span class="hint">graded assignments</span></div><section class="strip">${canvasHTML}</section>
<div class="sh"><h2>Board</h2><span class="hint">read-only — open the live deck to make changes</span></div>
<section class="board">${board}</section>
<footer><span>Generated from your Obsidian vault by GitHub Actions. This is a static, read-only view — status changes happen in the live deck or in Obsidian.</span></footer>
</main></body></html>`;
}

// ---- main ----
const root = join(VAULT_DIR, DIR);
const files = walk(root);
let tasks = [];
for (const f of files) {
  const rel = f.slice(VAULT_DIR.length + 1).replace(/\\/g, "/");
  tasks = tasks.concat(parseFile(rel, readFileSync(f, "utf8")));
}
// Canvas data is produced by build-canvas.mjs (runs first). Read it if present.
let canvas = [];
try { const cj = JSON.parse(readFileSync(join(OUT_DIR, "data", "canvas.json"), "utf8")); canvas = cj.items || []; } catch { canvas = []; }
const builtAt = new Date();

// data/tasks.json — open to-dos with due dates, for the cloud calendar mirror (excludes exams & done)
const codeOf = (k) => (k && COURSES[k] ? COURSES[k].code : null);
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const keyOf = (t) => createHash("sha1").update(norm(t.title) + "|" + (t.due || "")).digest("hex").slice(0, 12);
const todoItems = tasks
  .filter((t) => !t.isExam && !t.assignmentId && t.due && t.status !== "done")
  .map((t) => ({ title: t.title, due: t.due, code: codeOf(t.courseKey), courseKey: t.courseKey || null, key: keyOf(t) }));
mkdirSync(join(OUT_DIR, "data"), { recursive: true });
writeFileSync(join(OUT_DIR, "data", "tasks.json"), JSON.stringify({ builtAt: builtAt.toISOString(), items: todoItems }, null, 2));

writeFileSync(join(OUT_DIR, "snapshot.html"), render(tasks, canvas, builtAt));
console.log(`Snapshot built: ${tasks.length} tasks from ${files.length} notes, ${canvas.length} Canvas items, ${todoItems.length} open to-dos → tasks.json.`);
