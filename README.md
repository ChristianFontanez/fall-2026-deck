# Fall 2026 Command Deck — setup

A single-file, always-live dashboard that reads and writes the Tasks in your Obsidian vault
(`ChristianFontanez/obsidian-vault`, `School/Fall 2026`) directly through the GitHub API.
Checking or moving a card commits the change to your vault → Obsidian Git pulls it down.
Editing in Obsidian and pushing → the dashboard reads it back. Git is the two-way bus.

There are two files:
- `index.html` — the whole app (no build step, no dependencies)
- `README.md` — this guide

---

## 1. Create a scoped GitHub token (2 min)

The dashboard talks to GitHub as you, using a **fine-grained personal access token** limited to
just your vault repo. It's stored only in your browser.

1. Go to **github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
   (direct link: https://github.com/settings/tokens?type=beta )
2. **Token name:** `command-deck`  ·  **Expiration:** your call (90 days is a good default; you'll re-paste when it lapses)
3. **Resource owner:** `ChristianFontanez`
4. **Repository access:** *Only select repositories* → choose **`obsidian-vault`**
5. **Permissions → Repository permissions → Contents: Read and write**
   (leave everything else at "No access"; Metadata auto-sets to read-only — that's fine)
6. **Generate token**, copy the `github_pat_…` string.

You'll paste it into the dashboard the first time you open it. That's the only thing it needs.

---

## 2. Publish the app on GitHub Pages (5 min)

### Option A — with the `gh` CLI (fastest)

```bash
# in the folder that contains index.html
git init -b main
git add index.html README.md
git commit -m "Fall 2026 Command Deck"
gh repo create fall-2026-deck --public --source=. --remote=origin --push

# turn on GitHub Pages (main branch, root)
gh api -X POST repos/ChristianFontanez/fall-2026-deck/pages \
  -f "source[branch]=main" -f "source[path]=/"
```

Your dashboard will be live at:
**https://christianfontanez.github.io/fall-2026-deck/**  (give Pages ~1 minute to build)

### Option B — no CLI, all in the browser

1. Create a new **public** repo named `fall-2026-deck` on github.com.
2. Upload `index.html` (drag-and-drop on the repo page → Commit).
3. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, folder **/ (root)** → Save.
4. Wait ~1 min, then open the URL it shows (`https://christianfontanez.github.io/fall-2026-deck/`).

> The app repo is public, but it contains **no secrets** — only generic HTML/JS. Your vault stays
> private; its data only loads in your browser, with your token.

---

## 3. First run

Open the Pages URL → paste your token when prompted → the board fills in from your notes.

- **Move a card** (drag, or the ‹ › arrows): flips the checkbox in the note (`[ ]` → `[/]` → `[x]`)
  and commits it. Done also stamps a `✅ date`, matching the Tasks plugin.
- **+ Add to-do:** appends a task to `School/Fall 2026/Inbox.md` and commits it.
- **×** on a card: removes that line from its note (asks first).
- **⚙ Settings:** see/clear your token.
- **Add to Home Screen** (iOS Share menu / Android Chrome menu / desktop Chrome "Create shortcut →
  Open as window") to use it like an app.

---

## How the two-way sync behaves

- Obsidian Git is now set to **auto-pull on boot + every 5 min** and **auto-push every 5 min**
  (I enabled this). So a change you make on the dashboard shows up in Obsidian within ~5 minutes
  (or instantly if you hit the Obsidian Git "pull" hotkey), and vice-versa.
- The dashboard fetches fresh data on load, on the **refresh** button, and every 2 min while a tab
  is open. It always writes against the file's latest version and **re-syncs on conflict**, so a
  simultaneous Obsidian edit won't clobber anything — worst case it refreshes and you redo the click.
- Every change is a small commit (`deck: <task> → done`). That's normal; your history stays readable.

## Config (if you ever move things)

Top of the `<script>` in `index.html`:

```js
var CFG = { owner:"ChristianFontanez", repo:"obsidian-vault", branch:"main",
            dir:"School/Fall 2026", excludeFiles:["Fall 2026 Dashboard.md"],
            inbox:"School/Fall 2026/Inbox.md" };
```

Change `dir` to track a different term, or add filenames to `excludeFiles`.

## Security notes

- The token is **fine-grained and single-repo** (Contents R/W on `obsidian-vault` only), so even in the
  unlikely event it leaked, the blast radius is that one repo.
- It lives in your browser's `localStorage` on each device you use — clear it anytime from **⚙ Settings**,
  and revoke it on GitHub if a device is lost.
- Nothing is sent anywhere except `api.github.com`.

---

## 4. Automation: auto-snapshot + Canvas overlay (optional but recommended)

Two extra files make this a truly hands-off central dashboard:

- `scripts/build-snapshot.mjs` — parses your vault's Fall 2026 tasks (and, optionally, Canvas
  deadlines) and generates a static read-only `snapshot.html` + `data/canvas.json`.
- `.github/workflows/snapshot.yml` — a GitHub Action that runs the generator **every 20 minutes**
  (and on demand / on push), then commits the results.

What you get:
- **`snapshot.html`** — a zero-token, read-only view of your board, always current within ~20 min.
  Linked from the live deck's footer. Use it on a shared/public computer where you don't want to
  paste your token. Open at `…github.io/fall-2026-deck/snapshot.html`.
- **Canvas deadlines** — if you provide your Canvas calendar feed, graded assignments for your three
  courses appear in a read-only "Canvas deadlines" strip on **both** the live deck and the snapshot,
  so everything lives in one place.

### Set it up

1. **`VAULT_TOKEN` secret** (required for the Action to read your private vault):
   - Make a **second** fine-grained token, scoped to **`obsidian-vault`**, **Contents: Read** (read-only is enough).
   - In the **`fall-2026-deck`** repo → **Settings → Secrets and variables → Actions → New repository secret** →
     name `VAULT_TOKEN`, paste the token.

2. **`CANVAS_ICS` secret** (optional — enables the Canvas overlay):
   - In Canvas: **Calendar → Calendar Feed** (bottom-right) → copy the `https://…/feeds/calendars/….ics` URL.
   - Add it as a repo secret named `CANVAS_ICS`. Leave it unset to skip Canvas entirely.

3. Push the two new files (they're already in this folder), then in the repo's **Actions** tab click
   **Build dashboard snapshot → Run workflow** once to generate the first snapshot. After that it self-runs.

### ⚠️ Privacy — read this

`snapshot.html` and `data/canvas.json` are committed to the **public** `fall-2026-deck` repo and served
publicly, so **anyone with the URL can read your task titles and due dates** (and Canvas assignment names,
if enabled). Your *vault* stays private — only this course-task view is exposed. That's usually fine for
coursework, but if you'd rather not expose it:

- **Don't add the workflow** — the live token-gated deck alone is fully private, or
- Host the whole thing on **Cloudflare Pages / Vercel from a private repo** instead of GitHub Pages
  (tell me and I'll adjust the setup), or
- Keep the schedule but delete `snapshot.html` from Pages and use the snapshot only locally.

The `VAULT_TOKEN` and `CANVAS_ICS` are **repo secrets** — encrypted, never exposed in logs or to the browser.

---

## Live app extras

- **Filter chips** (under the progress bars): filter the board + timeline by class, "This week", or
  "Hide done". Your choice is remembered per browser.
- **Canvas deadlines strip**: read-only, populated from `data/canvas.json` once the Action has run.
- **Read-only snapshot** link in the footer.
