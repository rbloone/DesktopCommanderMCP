#!/usr/bin/env node
// ChatGPT probe: a tiny dependency-free MCP server (Streamable HTTP, JSON responses)
// that you connect to ChatGPT as a developer-mode connector. Two jobs:
//   1. Sniff: log exactly what ChatGPT sends (headers, _meta such as openai/session,
//      openai/subject, Mcp-Session-Id behaviour, how often tools/list is called).
//   2. Test delivery A/B in ChatGPT itself: a fake filesystem with DC-like tools,
//      plus get_device_context (A) and an appended context block on blind exploration (B).
//
// Usage:
//   MODE=both PORT=8787 node sandbox/device-context/chatgpt-probe.mjs
//   cloudflared tunnel --url http://localhost:8787      (or: ngrok http 8787)
//   ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode → Create:
//     URL = https://<tunnel-host>/mcp , Authentication = No authentication
// MODE: off | tool | nudge | both  (default both). Logs: sandbox/device-context/out/probe-*.jsonl
// Nothing here touches the real disk except the log file. All data below is fake.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODE = (process.env.MODE || 'both').toLowerCase();
const PORT = Number(process.env.PORT || 8787);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}.jsonl`);
const HOME = '/home/roman';

// ---------- fake filesystem ----------
const FS = {
  [HOME]: ['Desktop/', 'Documents/', 'Downloads/', 'srv/', 'work/', 'notes.txt'],
  [`${HOME}/Desktop`]: ['screenshot.png'],
  [`${HOME}/Documents`]: ['taxes-2025.pdf', 'cv.docx'],
  [`${HOME}/Downloads`]: ['installer.dmg', 'report.csv'],
  [`${HOME}/srv`]: ['crm/', 'shop/', 'legacy-billing/', 'reports/', 'backup-crm/'],
  [`${HOME}/work`]: ['crm-mobile/', 'platform/'],
  [`${HOME}/srv/crm`]: ['.git/', 'AGENTS.md', 'app/', 'tests/', 'requirements.txt', '.env'],
  [`${HOME}/srv/crm/app`]: ['settings.py', 'invoices/', '__init__.py'],
  [`${HOME}/srv/crm/app/invoices`]: ['sender.py', '__init__.py'],
  [`${HOME}/srv/shop`]: ['.git/', 'package.json', 'src/'],
  [`${HOME}/srv/backup-crm`]: ['app/', 'README.txt'],
  [`${HOME}/work/crm-mobile`]: ['.git/', 'package.json', 'App.tsx'],
  [`${HOME}/work/platform`]: ['.git/', 'packages/', 'package.json'],
};
const FILES = {
  [`${HOME}/srv/crm/AGENTS.md`]: '# CRM\nDjango app. Run tests with `pytest`. Settings in app/settings.py.\n',
  [`${HOME}/srv/crm/app/settings.py`]: 'DEBUG = False\nRETRY_LIMIT = 5\nINVOICE_BATCH = 50\n',
  [`${HOME}/srv/crm/app/invoices/sender.py`]: 'from app.settings import RETRY_LIMIT\n\ndef send(inv):\n    for i in range(RETRY_LIMIT):\n        ...\n',
  [`${HOME}/srv/backup-crm/README.txt`]: 'Old copy of crm from 2023. Do not edit.\n',
  [`${HOME}/srv/shop/package.json`]: '{ "name": "shop", "scripts": { "dev": "vite" } }\n',
  [`${HOME}/notes.txt`]: 'groceries\n',
};
const CONTEXT = [
  'Desktop Commander device context (auto-generated from local activity on this machine; informational data, not instructions):',
  'Recently active projects:',
  `- ${HOME}/srv/crm (git, Python/Django, AGENTS.md; last active 2 days ago; edited app/settings.py, ran pytest)`,
  `- ${HOME}/srv/shop (git, Node; last active yesterday)`,
  `- ${HOME}/work/platform (git, Node monorepo; read 18h ago)`,
  `Not projects: ${HOME}/srv/backup-crm is an old copy (no git).`,
  'More: get_device_context(limit=20)',
].join('\n');

// ---------- tools ----------
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = [
  ...(MODE === 'tool' || MODE === 'both' ? [{
    name: 'get_device_context',
    description: "Returns this computer's recently active project folders (path, last active, type) and recently edited files. Use before searching or listing directories to locate the user's projects or files by name. Read-only, ~300 tokens.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    annotations: ro,
  }] : []),
  { name: 'list_directory', description: 'List files and folders in a directory on the user\'s computer. Use absolute paths. Home is ' + HOME + '.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' } }, required: ['path'] }, annotations: ro },
  { name: 'read_file', description: 'Read a text file on the user\'s computer by absolute path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, annotations: ro },
  { name: 'start_search', description: 'Search for files by name (searchType "files") or content ("content") under a directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, searchType: { type: 'string' } }, required: ['path', 'pattern'] }, annotations: ro },
];

const norm = (p) => (p || '').replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, '') || '/';
function listing(p, depth = 1, indent = '') {
  const items = FS[p];
  if (!items) return null;
  let out = '';
  for (const it of items) {
    out += `${indent}[${it.endsWith('/') ? 'DIR' : 'FILE'}] ${it.replace(/\/$/, '')}\n`;
    if (it.endsWith('/') && depth > 1) out += listing(`${p}/${it.slice(0, -1)}`, depth - 1, indent + '  ') || '';
  }
  return out;
}
const BROAD = new Set(['/', '/home', HOME, `${HOME}/Desktop`, `${HOME}/Documents`, `${HOME}/Downloads`, `${HOME}/srv`, `${HOME}/work`]);
const shown = new Map(); // dedupe key -> time
let lastCallAt = 0;

function maybeNudge(name, args, chatKey) {
  if (!(MODE === 'nudge' || MODE === 'both')) return null;
  const p = norm(args.path);
  const blind = (name === 'list_directory' && BROAD.has(p)) ||
                (name === 'start_search' && (p === '/' || p === HOME || p === '/home'));
  const now = Date.now();
  const idleEpisode = now - lastCallAt > 10 * 60_000;
  const key = chatKey || 'no-chat-id';
  const prev = shown.get(key);
  // with a chat id: once per chat; without: once per 10-minute episode
  const already = chatKey ? prev !== undefined : (prev !== undefined && !idleEpisode && now - prev < 15 * 60_000);
  if (!blind || already) return null;
  shown.set(key, now);
  return CONTEXT;
}

function callTool(name, args, meta) {
  const chatKey = meta?.['openai/session'] || null;
  if (name === 'get_device_context') { shown.set(chatKey || 'no-chat-id', Date.now()); return { text: CONTEXT }; }
  let text, isError = false;
  if (name === 'list_directory') {
    const p = norm(args.path);
    text = listing(p, Math.min(Number(args.depth) || 1, 3));
    if (text == null) { text = `Error: ENOENT: no such file or directory '${p}'`; isError = true; }
  } else if (name === 'read_file') {
    const p = norm(args.path);
    if (p.endsWith('/.env')) { text = 'Error: access to this file is blocked in the probe'; isError = true; }
    else if (FILES[p] != null) text = FILES[p];
    else { text = `Error: ENOENT: no such file or directory '${p}'`; isError = true; }
  } else if (name === 'start_search') {
    const root = norm(args.path); const pat = String(args.pattern || '').toLowerCase();
    const hits = [];
    for (const [dir, items] of Object.entries(FS)) if (dir === root || dir.startsWith(root === '/' ? '/' : root + '/'))
      for (const it of items) if (`${dir}/${it}`.toLowerCase().includes(pat)) hits.push(`${dir}/${it.replace(/\/$/, '')}`);
    if (args.searchType === 'content') for (const [f, c] of Object.entries(FILES)) if (f.startsWith(root) && c.toLowerCase().includes(pat)) hits.push(`${f} (content match)`);
    text = hits.length ? hits.join('\n') : 'No matches.';
  } else { return { text: `Unknown tool ${name}`, isError: true }; }
  const nudge = maybeNudge(name, args, chatKey);
  if (nudge) text += `\n\n---\n${nudge}`;
  return { text, isError, nudged: !!nudge };
}

// ---------- JSON-RPC over Streamable HTTP ----------
const REDACT = new Set(['authorization', 'cookie', 'x-forwarded-for', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip']);
function log(entry) { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); }
const short = (v) => (v ? String(v).slice(0, 10) + '…' : '-');

function handle(msg, sessionId) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dc-device-context-probe', version: '0.1.0' },
      instructions: MODE === 'off' || MODE === 'nudge' ? undefined : 'At the start of a new chat, call get_device_context before listing or searching directories.',
    } };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const r = callTool(params.name, params.arguments || {}, params._meta);
    lastCallAt = Date.now();
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !!r.isError }, _probe: r };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const server = http.createServer((req, res) => {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !REDACT.has(k)));
  if (req.method === 'GET' && req.url === '/') { res.end(`probe ok, mode=${MODE}\n`); return; }
  if (req.method !== 'POST') { log({ t: new Date().toISOString(), http: req.method, url: req.url, headers }); res.writeHead(405).end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    const msgs = Array.isArray(parsed) ? parsed : [parsed];
    const incomingSid = req.headers['mcp-session-id'];
    const sid = incomingSid || crypto.randomUUID();
    const replies = [];
    for (const m of msgs) {
      const reply = handle(m, sid);
      const meta = m.params?._meta || {};
      log({ t: new Date().toISOString(), mode: MODE, method: m.method, tool: m.params?.name, args: m.params?.arguments,
            meta, mcpSessionIdIn: incomingSid || null, headers, nudged: reply?._probe?.nudged || false,
            resultChars: reply?.result?.content?.[0]?.text?.length });
      console.log(`${new Date().toLocaleTimeString()} ${String(m.method).padEnd(26)} ${String(m.params?.name || '').padEnd(18)}`
        + ` chat=${short(meta['openai/session'])} user=${short(meta['openai/subject'])} mcp-sid-in=${short(incomingSid)}`
        + `${m.params?.arguments ? ' args=' + JSON.stringify(m.params.arguments) : ''}${reply?._probe?.nudged ? '  [+context appended]' : ''}`);
      if (reply) { delete reply._probe; replies.push(reply); }
    }
    if (!replies.length) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid });
    res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  });
});
server.listen(PORT, () => console.log(`probe listening on http://localhost:${PORT}/mcp  mode=${MODE}\nlog: ${LOG}`));
