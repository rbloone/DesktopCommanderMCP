# Device context sandbox

A reproducible playground for the persistent device context feature: scripted
"mock agent" sessions run against the real built server inside a throwaway HOME
full of fake projects. Each run produces an HTML report showing what the server
recorded and **exactly what a new chat would receive**.

Nothing touches your real Desktop Commander config or history: the server is
started with `HOME`/`USERPROFILE` pointing at a temporary folder, telemetry
disabled, onboarding off.

## Click through it (interactive)

```bash
npm install && npm run build
node sandbox/device-context/ui.mjs      # open http://localhost:4321
```

Buttons: reset the fake HOME, open a new chat window (fresh server process),
move the clock, step through a scenario (`Next step ▶`) or call any tool by hand.
Every step shows the server's answer, what the feature would store or drop (and
why), the ranking, and what a new chat would receive right now.

## Run all scenarios (batch, with checks)

```bash
npm install
npm run build
node sandbox/device-context/run.mjs            # all scenarios
node sandbox/device-context/run.mjs 01         # scenarios whose file name starts with 01
node sandbox/device-context/run.mjs --dry-run  # no server: only the prototype pipeline
node sandbox/device-context/run.mjs --keep     # keep the fake HOME for poking around
```

Reports land in `sandbox/device-context/out/<scenario>.html` (git-ignored).

## How it works

```
scenarios/*.json ──► run.mjs ──► fake HOME (fake-home.mjs)
                        │            srv/crm, srv/shop, srv/legacy-billing, decoys,
                        │            a monorepo, a prompt-injection folder, fake secrets
                        │
                        ├─► dist/index.js (real server, one process per "session";
                        │     a "restart" step = new process = new chat window)
                        │
                        ├─► observe(event)      per tool call, like the future server hook:
                        │     extract paths → project root → filters → clean journal row
                        │
                        └─► get_device_context  if the server has the tool, its answer;
                              otherwise contextFrom(journal) from preview.mjs (prototype)
```

- **fake-home.mjs** — creates the fake projects (real git repos with back-dated
  commits when `git` is available).
- **preview.mjs** — the prototype algorithm: path extraction, project detection
  (nearest `.git`, then a manifest), deny-list and secret patterns, ranking
  (active days × recency, zoxide-style multipliers), rendering with escaping.
  It lives here so it can be iterated on quickly before moving into `src/`.
- **run.mjs** — plays scenarios, checks expectations, writes reports.

Each `get_device_context` call is answered at the scenario's time, so decay over
days or months can be tested in seconds.

## Scenarios

| File | What it checks |
|---|---|
| `01-new-chat-after-two-days.json` | Main case: work in two projects over two days, then a new chat. |
| `02-secrets-and-traps.json` | Secrets in commands, `.env`, `.ssh`, relative paths, Desktop Commander's own folder, decoys, prompt-injection folder names. |
| `03-staleness.json` | A project is moved away; new chats after 2 hours, 3 days, 2 weeks, 2 months. |

Scenario format:

```json
{ "name": "...", "steps": [
  { "session": "Day 1", "client": "claude-code", "at": "2026-11-17T10:00:00Z", "calls": [
    { "tool": "read_file", "args": { "path": "{home}/srv/crm/app/settings.py" } }
  ]},
  { "restart": true },
  { "fs": { "rename": ["{home}/srv/a", "{home}/srv/b"] } },
  { "session": "Day 3", "client": "chatgpt-sim", "at": "2026-11-19T09:00:00Z", "calls": [
    { "tool": "get_device_context", "args": {}, "expect": {
      "inTop": ["{home}/srv/crm"], "contains": ["AGENTS.md"],
      "notInOutput": ["FAKECANARY"], "maxTokens": 800 } }
  ]}
]}
```

`{home}` is the fake HOME, `{dc}` is this repository. Calls within a session are
one minute apart.

## ChatGPT probe (`chatgpt-probe.mjs`)

A tiny dependency-free MCP server (Streamable HTTP) that you connect to ChatGPT (developer
mode) or Claude.ai (custom connector). It does three things:

1. **Sniffs** what the client sends: `_meta` (`openai/session` = conversation id,
   `openai/subject` = user id, locale, ...), headers, `Mcp-Session-Id` behaviour, how often
   `tools/list` is re-fetched. IPs and auth headers are not logged.
2. **Imitates DC tools on a fake disk** (`/home/roman/srv/crm`, `srv/shop`, decoys
   `srv/backup-crm` and `work/crm-mobile`, ...): `list_directory`, `read_file`, `start_search`,
   `start_process` (pwd, ls, find, grep, cat).
3. **Tests delivery:** `get_device_context` (A) and a context block appended to a tool result (B):

   | Case | Example call | What is appended |
   |---|---|---|
   | exact | `read_file /home/roman/srv/crm/app/settings.py` | nothing (the agent already knows where it is) |
   | partial | `start_search pattern="crm"`, `read_file ~/projects/crm/...` → not found | one targeted line: `crm = /home/roman/srv/crm`, plus "Did you mean" for a guessed path |
   | none | `list_directory ~`, `find ~ -name ...`, missing `~/code` | short top-5 of recent projects |

   Once per episode: per chat when a chat id arrives in `_meta`, otherwise per 10-minute idle gap.
   Nothing is appended after `get_device_context` was called or after the agent reached a project.

Nothing touches the real disk except the log file. The probe never proxies to a real Desktop
Commander: a public tunnel without auth in front of real DC would expose the whole machine.

### Viewer

Open `http://localhost:8787/_probe/ui` (local only). For every call it shows three columns:

1. **client → probe:** the exact request ChatGPT sent, with headers and `_meta`;
2. **tool result:** what the DC-like tool returned, with the appended device context in green and
   the B decision (`case=exact|partial|none` and why);
3. **probe → client:** the exact JSON sent back.

The header shows per-chat stats: calls, first tool, whether `get_device_context` was called,
`found_target_at_call` (first call inside `TARGET`, default `/home/roman/srv/crm`), nudges,
injected tokens, and wrong-project hits (decoys). The same stats print on Ctrl+C and are at
`/_probe/stats`. Full log, one JSON line per message: `out/probe-<time>-<mode>.jsonl` (`out/` is git-ignored).

### Offline test (no ChatGPT needed)

```
node sandbox/device-context/chatgpt-probe.test.mjs
```

Plays scripted agent calls against the probe in modes `both`, `off`, `tool` and checks every case
above, decoys, false-positive guards (`ls ~/Downloads`, reading `~/notes.txt`) and the
10-minute episode rule (fake clock via `PROBE_TEST=1`).

### Run against ChatGPT (Windows / PowerShell)

Requirements: Node 18+, ChatGPT plan with Developer mode (Plus/Pro), `cloudflared` (or `ngrok`).

```powershell
winget install Cloudflare.cloudflared            # once

# terminal 1, in the repo root. MODE = off | tool | nudge | both (default both), PORT default 8787
$env:MODE="both"; node sandbox\device-context\chatgpt-probe.mjs

# terminal 2
cloudflared tunnel --url http://localhost:8787   # copy https://<random>.trycloudflare.com
```

macOS/Linux: `MODE=both node sandbox/device-context/chatgpt-probe.mjs`.

ChatGPT → Settings → Apps & Connectors → Advanced → enable **Developer mode** → **Create**:
URL `https://<random>.trycloudflare.com/mcp`, Authentication: **No authentication**.
(Menu names may differ slightly.)

Claude.ai: Settings → Connectors → Add custom connector, same URL. Check whether Claude sends any
conversation id in `_meta`.

### Test protocol

1. New chat with the connector enabled: "in my crm project, what is RETRY_LIMIT set to?"
2. Same chat: one more question about the project.
3. Second new chat: "find my crm project and show its settings" (invites a search).
4. Run each mode in fresh chats: `both`, `nudge` (B only), `tool` (A only), `off` (baseline).
   After changing MODE, press Refresh on the connector and note whether ChatGPT picked up the new
   tool list without it.

What to look for:

| What | Where |
|---|---|
| Conversation id is sent, stable within a chat, different across chats | chat tag in the viewer |
| A works: the model calls `get_device_context` first on its own | `first=` in stats |
| B works: after the green block the next call goes straight to `srv/crm` | `found_target_at_call` |
| Decoys: the model picks `backup-crm` or `crm-mobile` by mistake | `wrong_project` |
| The block is treated as suspicious / ignored | the chat reply itself |
| ChatGPT caches the tool list | step 4 |
| `Mcp-Session-Id` echoed back or a new session every call | column 1, header `mcp-session-id` |

**Safety:** while the tunnel is up the URL is public, but it only serves fake data. Close both
terminals after the test.

## Live viewer for a real Desktop Commander (`live.mjs`)

Read-only page that shows what a real DC (local or the remote daemon) is doing, from files DC
already writes. No changes to DC needed.

```bash
# start the remote daemon with its console saved, so the viewer can show backend metadata
node dist/index.js remote 2>&1 | tee -a ~/dc-remote.log
# in another shell, as the same user
node sandbox/device-context/live.mjs           # http://localhost:8788 (bound to 127.0.0.1)
# from your laptop to a VPS:  ssh -L 8788:localhost:8788 root@<vps-ip>
```

Per call: (1) the call and the metadata the DC backend sent with it, (2) DC's result as stored in
`tool-history.jsonl` (DC caps it at ~4 KB), (3) what device context stored / appended once the
feature exists. Per episode (new episode after 10 min idle; DC has no chat id): calls until the
first call inside a project (git folders under `~/code`, `~/srv`, `~/work`) and the output chars
spent before that (≈ discovery tokens = chars / 4). Env: `HISTORY`, `DAEMON_LOG`, `EPISODE_GAP_MIN`,
`PROJECT_ROOTS`, `PORT`.
