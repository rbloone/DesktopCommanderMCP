#!/usr/bin/env node
// Live viewer for a REAL Desktop Commander (local or remote daemon) on this machine.
// Read-only: it only reads files Desktop Commander already writes, and serves a page on localhost.
//
//   node sandbox/device-context/live.mjs            -> http://localhost:8788
//
// Sources (all optional except the history):
//   HISTORY     ~/.claude-server-commander/tool-history.jsonl   every tool call: args + output (output capped ~4KB by DC)
//   DAEMON_LOG  file with the remote daemon's console output    what the DC backend sent with each call (metadata)
//               start the daemon with:  node dist/index.js remote 2>&1 | tee -a ~/dc-remote.log
//   JOURNAL     ~/.claude-server-commander/device-context-events.jsonl   what device context stored (once the feature exists)
//   DEBUG       ~/.claude-server-commander/device-context-debug.jsonl    what device context appended (once the feature exists)
//
// Episodes: calls are grouped into episodes by idle gaps (EPISODE_GAP_MIN, default 10) because DC has no chat id.
// Per episode it shows "calls until first call inside a project" and the output chars spent before that
// (a proxy for discovery tokens: chars / 4). Projects = folders with .git under PROJECT_ROOTS (default ~/code, ~/srv, ~/work).
// Remote access: keep the port closed and use  ssh -L 8788:localhost:8788 root@<vps>

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CFG = path.join(HOME, '.claude-server-commander');
const PORT = Number(process.env.PORT || 8788);
const HISTORY = process.env.HISTORY || path.join(CFG, 'tool-history.jsonl');
const DAEMON_LOG = process.env.DAEMON_LOG || path.join(HOME, 'dc-remote.log');
const JOURNAL = process.env.JOURNAL || path.join(CFG, 'device-context-events.jsonl');
const DEBUG = process.env.DEBUG_LOG || path.join(CFG, 'device-context-debug.jsonl');
const GAP_MS = Number(process.env.EPISODE_GAP_MIN || 10) * 60_000;
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS || ['code', 'srv', 'work'].map((d) => path.join(HOME, d)).join(':')).split(':');

const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const jsonLines = (f) => readLines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function projects() {
  const out = [];
  for (const root of PROJECT_ROOTS) {
    let names = []; try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) { const p = path.join(root, n); if (fs.existsSync(path.join(p, '.git'))) out.push(p); }
  }
  return out;
}
function pathsOf(args) {
  const a = args || {}; const ps = [];
  for (const k of ['path', 'source', 'destination', 'directory', 'cwd']) if (typeof a[k] === 'string') ps.push(a[k]);
  if (Array.isArray(a.paths)) ps.push(...a.paths.filter((x) => typeof x === 'string'));
  if (typeof a.command === 'string') ps.push(...(a.command.match(/(?:~|\/)[^\s'";|&]+/g) || []));
  return ps.map((p) => p.replace(/^~(?=\/|$)/, HOME));
}
const textOf = (out) => (out?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
// DC replaces outputs over 4 KB in history with "[output omitted from history: <size>, ...]": use that size
function sizeOf(text) {
  const m = text.match(/omitted from history:\s*([\d.,]+)\s*(bytes|B|KB|KiB|MB|MiB)?/i);
  if (!m) return text.length;
  const n = parseFloat(m[1].replace(',', '')); const u = (m[2] || 'B').toLowerCase();
  return Math.round(u.startsWith('m') ? n * 1048576 : u.startsWith('k') ? n * 1024 : n);
}

// daemon log lines: "🔧 Received tool call <id>: <tool> <args-json> metadata: <json>"
function daemonCalls() {
  const res = [];
  for (const l of readLines(DAEMON_LOG)) {
    const m = l.match(/Received tool call (\S+): (\S+) (.*) metadata: (.*)$/);
    if (!m) continue;
    let args = null, meta = null; try { args = JSON.parse(m[3]); } catch {} try { meta = JSON.parse(m[4]); } catch {}
    res.push({ callId: m[1], tool: m[2], args, meta, used: false });
  }
  return res;
}

function build() {
  const hist = jsonLines(HISTORY);
  const daemon = daemonCalls();
  const journal = jsonLines(JOURNAL);
  const debug = jsonLines(DEBUG);
  const projs = projects();
  const inProject = (ps) => ps.find((p) => projs.some((r) => p === r || p.startsWith(r + '/')));
  const events = [];
  let ep = null, n = 0;
  const episodes = [];
  for (const h of hist) {
    const t = Date.parse(h.timestamp);
    if (!ep || t - ep.lastAt > GAP_MS) { ep = { id: episodes.length + 1, start: h.timestamp, lastAt: t, calls: 0, foundAt: null, project: null, charsBefore: 0, nudges: 0, remote: 0 }; episodes.push(ep); }
    ep.lastAt = t; ep.calls++;
    // match the daemon line for the same call (same tool + same args, first unused)
    const argStr = JSON.stringify(h.arguments);
    const d = daemon.find((x) => !x.used && x.tool === h.toolName && JSON.stringify(x.args) === argStr);
    if (d) { d.used = true; ep.remote++; }
    const out = textOf(h.output);
    const ps = pathsOf(h.arguments);
    const hit = inProject(ps);
    if (hit && ep.foundAt == null) { ep.foundAt = ep.calls; ep.project = projs.find((r) => hit === r || hit.startsWith(r + '/')); }
    if (ep.foundAt == null) ep.charsBefore += sizeOf(out);
    const near = (rows, key = 't') => rows.filter((r) => Math.abs(Date.parse(r[key] || r.timestamp) - t) < 3000);
    const stored = near(journal);
    const decisions = near(debug).filter((r) => r.event === 'decision' && r.tool === h.toolName);
    const appended = decisions.find((r) => r.appended) || null;
    if (appended) ep.nudges++;
    events.push({ seq: ++n, episode: ep.id, t: h.timestamp, tool: h.toolName, args: h.arguments, duration: h.duration,
      origin: d ? 'remote' : 'local', callId: d?.callId || null, metadata: d?.meta || null,
      output: out, size: sizeOf(out), isError: !!h.output?.isError, inProject: hit || null, stored, appended, decision: decisions[0] || null });
  }
  return { files: { HISTORY, DAEMON_LOG, JOURNAL, DEBUG }, projects: projs, gapMin: GAP_MS / 60_000, events: events.slice(-500), episodes };
}

const UI = `<!doctype html><html><head><meta charset="utf-8"><title>DC live</title><style>
:root{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--fg:#e6e6e6;--mut:#8b93a4;--in:#5aa9ff;--tool:#c9a227;--add:#3fbf7f}
body{margin:0;font:13px/1.45 ui-sans-serif,system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;z-index:2}
header b{font-size:15px} .m{color:var(--mut);font-family:ui-monospace,Consolas,monospace;font-size:12px}
table{border-collapse:collapse;margin-top:6px;font-size:12px} td,th{border:1px solid var(--line);padding:2px 8px;text-align:left}
main{padding:12px 16px} details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:6px 0}
summary{cursor:pointer;padding:7px 12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;list-style:none}
.ep{border-radius:4px;padding:0 6px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.tag{border-radius:4px;padding:0 6px;font-size:12px;background:#222833;color:var(--mut)} .ok{background:#163d2a;color:var(--add)} .err{background:#4a1d1d;color:#ff8a8a}
.cols{display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:8px;padding:0 12px 12px} @media(max-width:1100px){.cols{grid-template-columns:1fr}}
h4{margin:4px 0;font-size:12px;text-transform:uppercase;letter-spacing:.04em} .c1 h4{color:var(--in)} .c2 h4{color:var(--tool)} .c3 h4{color:var(--add)}
pre{margin:0;white-space:pre-wrap;word-break:break-word;background:#0b0d11;border:1px solid var(--line);border-radius:6px;padding:8px;max-height:380px;overflow:auto;font:12px/1.4 ui-monospace,Consolas,monospace}
</style></head><body><header><b>Desktop Commander — live</b> <span class="m" id="files"></span><div id="eps"></div></header><main id="list"></main>
<script>
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const J=o=>esc(JSON.stringify(o,null,2));
const pal=['#24405f','#4a2f5c','#2f5146','#5c442a','#3d3d66','#5a2e3a'];const epTag=i=>'<span class="ep" style="background:'+pal[(i-1)%pal.length]+'">episode '+i+'</span>';
let last=-1;const open=new Set();
async function poll(){try{const j=await (await fetch('/api')).json();
document.getElementById('files').textContent='history: '+j.files.HISTORY+' · daemon log: '+j.files.DAEMON_LOG+' · new episode after '+j.gapMin+' min idle · projects: '+j.projects.length;
document.getElementById('eps').innerHTML='<table><tr><th>episode</th><th>start</th><th>calls</th><th>remote</th><th>first call inside a project</th><th>project</th><th>output chars before (≈tokens)</th><th>context appended</th></tr>'+j.episodes.slice(-12).reverse().map(e=>'<tr><td>'+epTag(e.id)+'</td><td>'+e.start.slice(0,19).replace('T',' ')+'</td><td>'+e.calls+'</td><td>'+e.remote+'</td><td>'+(e.foundAt??'–')+'</td><td>'+esc(e.project||'–')+'</td><td>'+e.charsBefore+' (≈'+Math.round(e.charsBefore/4)+')</td><td>'+e.nudges+'</td></tr>').join('')+'</table>';
const L=document.getElementById('list');
for(const d of L.querySelectorAll('details[open]'))open.add(d.dataset.seq);
L.innerHTML=j.events.slice().reverse().map(e=>'<details data-seq="'+e.seq+'"'+(open.has(String(e.seq))?' open':'')+'><summary><span class="m">#'+e.seq+' '+e.t.slice(11,19)+'</span>'+epTag(e.episode)+'<b>'+esc(e.tool)+'</b><span class="m">'+esc(JSON.stringify(e.args)).slice(0,160)+'</span><span class="tag">'+e.origin+'</span>'+(e.isError?'<span class="tag err">error</span>':'')+(e.inProject?'<span class="tag ok">in project</span>':'')+(e.appended?'<span class="tag ok">+context</span>':'')+'</summary>'
+'<div class="cols"><div class="col c1"><h4>1 · call (from AI'+(e.metadata?' via DC backend':'')+')</h4><pre>'+J({tool:e.tool,arguments:e.args,callId:e.callId,metadata_from_backend:e.metadata,duration_ms:e.duration})+'</pre></div>'
+'<div class="col c2"><h4>2 · DC result (as stored in history, capped)</h4><pre>'+esc(e.output)+'</pre></div>'
+'<div class="col c3"><h4>3 · device context</h4><pre>'+(e.decision?'B DECISION: '+esc(e.decision.case+' — '+e.decision.reason+(e.appended?' → appended '+e.appended.appended:' → nothing appended'))+'\\n\\n':'')+(e.appended?'APPENDED:\\n'+esc(e.appended.text||'')+'\\n\\n':'')+(e.stored.length?'STORED:\\n'+J(e.stored):'<span class="m">nothing stored / feature not enabled</span>')+'</pre></div></div></details>').join('');
}catch(err){}setTimeout(poll,1500)}poll();
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/api') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(build())); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(UI);
}).listen(PORT, '127.0.0.1', () => console.log(`DC live viewer: http://localhost:${PORT}\nhistory: ${HISTORY}\ndaemon log: ${DAEMON_LOG}`));
