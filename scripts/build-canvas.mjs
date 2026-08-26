// Fetches the Canvas calendar feed (CANVAS_ICS) and writes data/canvas.json for the deck.
// Runs in GitHub Actions. No npm dependencies (Node 20+, global fetch).
//
// Env:
//   CANVAS_ICS  the Canvas "Calendar Feed" URL (…/feeds/calendars/user_XXXX.ics). Required.
//   OUT_DIR     where to write data/canvas.json (default: ".")

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CANVAS_ICS = process.env.CANVAS_ICS || "";
const OUT_DIR = process.env.OUT_DIR || ".";

const COURSES = {
  cms450: { code: "CMS 450", name: "Computer Networks", num: "94295" },
  mat219: { code: "MAT 219", name: "Probability & Statistics", num: "94468" },
  cms270: { code: "CMS 270", name: "Object-Oriented Design", num: "94291" },
};
const NUM_TO_KEY = { "94295": "cms450", "94468": "mat219", "94291": "cms270" };

function unfold(ics) { return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, ""); }
function unesc(s) { return String(s || "").replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\"); }
function stripHtml(s) { return unesc(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim(); }

function field(body, name) {
  const m = body.match(new RegExp("\\n" + name + "(?:;[^:\\n]*)?:(.*)", ""));
  return m ? m[1].trim() : null;
}
function toISO(dt) {
  if (!dt) return { iso: null, allDay: false };
  if (/^\d{8}$/.test(dt)) return { iso: `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}`, allDay: true };
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, allDay: false };
  return { iso: null, allDay: false };
}
function courseKeyOf(summary) {
  const n = summary.match(/\((\d{4,6})\)\s*\]?\s*$/) || summary.match(/\((\d{4,6})\)/);
  if (n && NUM_TO_KEY[n[1]]) return NUM_TO_KEY[n[1]];
  const s = summary.toLowerCase();
  if (/computer networks/.test(s)) return "cms450";
  if (/probability|statistic/.test(s)) return "mat219";
  if (/object[- ]orient/.test(s)) return "cms270";
  return null; // excludes internship & anything else
}
function directLink(url) {
  if (!url) return null;
  const c = url.match(/course_(\d+)/);
  const a = url.match(/assignment_(\d+)/);
  if (c && a) return `https://rollins.instructure.com/courses/${c[1]}/assignments/${a[1]}`;
  return url;
}

async function main() {
  if (!CANVAS_ICS) { console.log("No CANVAS_ICS set — writing empty canvas.json."); return write([]); }
  const url = CANVAS_ICS.replace(/^webcal:/, "https:");
  let ics;
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) { console.log("Canvas feed HTTP", r.status, "— writing empty."); return write([]); }
    ics = await r.text();
  } catch (e) { console.log("Canvas feed error:", e.message, "— writing empty."); return write([]); }

  const blocks = unfold(ics).split("BEGIN:VEVENT").slice(1);
  const items = [];
  const seen = new Set();
  for (const b of blocks) {
    const body = "\n" + b.split("END:VEVENT")[0];
    const summary = field(body, "SUMMARY");
    const dtstart = field(body, "DTSTART");
    if (!summary || !dtstart) continue;
    const key = courseKeyOf(summary);
    if (!key) continue;
    const { iso, allDay } = toISO(dtstart);
    if (!iso) continue;
    const rawUrl = field(body, "URL");
    const link = directLink(rawUrl);
    const aid = (rawUrl && (rawUrl.match(/assignment_(\d+)/) || [])[1]) || null;
    const title = unesc(summary).replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    let desc = field(body, "DESCRIPTION");
    desc = desc ? stripHtml(desc) : "";
    if (desc.length > 500) desc = desc.slice(0, 500).replace(/\s+\S*$/, "") + "…";
    const id = aid || (key + ":" + title + ":" + iso);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, courseKey: key, code: COURSES[key].code, title, due: iso, allDay, url: link, desc });
  }
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  console.log(`Canvas: ${items.length} assignments across tracked courses (from ${blocks.length} feed events).`);
  write(items);
}

function write(items) {
  mkdirSync(join(OUT_DIR, "data"), { recursive: true });
  writeFileSync(join(OUT_DIR, "data", "canvas.json"), JSON.stringify({ builtAt: new Date().toISOString(), items }, null, 2));
}

await main();
