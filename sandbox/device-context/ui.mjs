#!/usr/bin/env node
// Interactive device-context sandbox: a local web page with buttons.
//
//   node sandbox/device-context/ui.mjs            # then open http://localhost:4321
//   node sandbox/device-context/ui.mjs --dry-run  # without starting the real server
//
// Create a fake HOME, open a "new chat window" (a fresh server process), call
// tools one by one or step through a scenario, move the clock, and watch every
// step: the server's answer, what the feature would store or drop (and why),
// and what a new chat would receive right now.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createFakeHome, FAKE_STRIPE_KEY } from './fake-home.mjs';
import { observe, contextFrom } from './preview.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist', 'index.js');
const PORT = Number(process.env.PORT ?? 4321);
const DRY = process.argv.includes('--dry-run') || !fs.existsSync(DIST);

// ---------- state ----------
const S = {
  root: null, home: null, now: new Date('2026-11-17T10:00:00Z'),
  conn: null, client: 'claude-code', tools: [],
  journal: [], dropped: [], log: [],
  scenario: null, cursor: { step: 0, call: 0 },
};

function substitute(value) {
  const vars = { home: S.home, dc: REPO };
  if (typeof value === 'string') return value.replace(/\{fake_stripe_key\}/g, FAKE_STRIPE_KEY).replace(/\{(home|dc)\}([^\s"']*)/g, (_, k, rest) => rest ? path.join(vars[k], ...rest.split('/').filter(Boolean)) : vars[k]);
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  return value;
}
const textOf = (r) => (r?.content ?? []).map((p) => p.text ?? `[${p.type}]`).join('\n');

async function disconnect() {
  if (S.conn) { await S.conn.client.close().catch(() => {}); S.conn = null; }
}

async function connect(clientName) {
  await disconnect();
  S.client = clientName || S.client;
  if (DRY) { S.tools = []; S.log.push({ marker: `new chat window · ${S.client} · (dry run: server not started)` }); return; }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath, args: [DIST, '--no-onboarding'], cwd: path.dirname(DIST), stderr: 'pipe',
    env: { ...process.env, HOME: S.home, USERPROFILE: S.home, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_DEVICE_CONTEXT_NOW: S.now.toISOString() },
  });
  const client = new Client({ name: S.client, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 30_000 });
  S.tools = (await client.listTools()).tools.map((t) => t.name);
  S.conn = { client };
  S.log.push({ marker: `new chat window · ${S.client} · server started (${S.tools.length} tools)` });
}

async function reset() {
  await disconnect();
  if (S.root) { try { fs.rmSync(S.root, { recursive: true, force: true }); } catch { /* ignore */ } }
  S.root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sandbox-ui-'));
  S.home = path.join(S.root, 'home');
  createFakeHome(S.home, { now: S.now });
  S.journal = []; S.dropped = []; S.log = [{ marker: `fresh fake HOME · ${S.home}` }];
  S.scenario = null; S.cursor = { step: 0, call: 0 };
}

async function callTool(tool, args) {
  if (!S.home) await reset();
  const t = S.now.toISOString();
  args = substitute(args ?? {});
  const entry = { t, tool, args, client: S.client };
  if (tool === 'get_device_context') {
    const ctx = contextFrom(S.journal, S.dropped, { home: S.home, now: S.now, project: args.project });
    let serverText = null;
    if (S.conn && S.tools.includes('get_device_context')) serverText = textOf(await S.conn.client.callTool({ name: tool, arguments: args }));
    entry.result = serverText ?? ctx.text; entry.source = serverText ? 'server' : 'prototype (preview.mjs)'; entry.ok = true;
    entry.isContext = true;
  } else {
    let ok = true; let text = '(dry run: tool not executed)';
    if (S.conn) {
      try { const r = await S.conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60_000 }); ok = !r.isError; text = textOf(r); }
      catch (e) { ok = false; text = `ERROR: ${e.message}`; }
    } else if (!DRY) { text = '(no chat window open — click "New chat window" first; recorded anyway)'; }
    const seen = observe({ t, tool, args, ok, origin: /chatgpt|remote/i.test(S.client) ? 'remote' : 'local' }, { home: S.home, excludeRoots: [REPO] });
    S.journal.push(...seen.journal); S.dropped.push(...seen.dropped);
    Object.assign(entry, { ok, result: text.slice(0, 3000), stored: seen.journal, dropped: seen.dropped });
  }
  S.log.push(entry);
  S.now = new Date(S.now.getTime() + 60_000);
  return entry;
}

function scenarios() {
  return fs.readdirSync(path.join(HERE, 'scenarios')).filter((f) => f.endsWith('.json')).sort();
}

async function loadScenario(file) {
  await reset();
  S.scenario = JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios', path.basename(file)), 'utf8'));
  S.scenario.file = file; S.cursor = { step: 0, call: 0 };
  S.log.push({ marker: `scenario loaded: ${S.scenario.name}` });
}

async function nextStep() {
  const sc = S.scenario; if (!sc) return { done: true, note: 'no scenario loaded' };
  const step = sc.steps[S.cursor.step];
  if (!step) return { done: true, note: 'scenario finished' };
  if (step.restart) { await disconnect(); S.log.push({ marker: 'window closed (server stopped)' }); S.cursor = { step: S.cursor.step + 1, call: 0 }; return { done: false }; }
  if (step.fs) {
    const [a, b] = substitute(step.fs.rename); fs.renameSync(a, b);
    S.log.push({ marker: `filesystem: ${path.relative(S.home, a)} → ${path.relative(S.home, b)}` });
    S.cursor = { step: S.cursor.step + 1, call: 0 }; return { done: false };
  }
  if (S.cursor.call === 0) {
    S.now = new Date(step.at);
    await connect(step.client);
    S.log.push({ marker: `session: ${step.session}` });
  }
  const call = step.calls[S.cursor.call];
  await callTool(call.tool, call.args);
  S.cursor.call++;
  if (S.cursor.call >= step.calls.length) S.cursor = { step: S.cursor.step + 1, call: 0 };
  return { done: false };
}

function files() {
  if (!S.home) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.claude-server-commander' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1); else out.push('{home}/' + path.relative(S.home, p).split(path.sep).join('/'));
    }
  };
  walk(S.home, 0);
  return out.sort();
}

function state() {
  const ctx = S.home ? contextFrom(S.journal, S.dropped, { home: S.home, now: S.now }) : null;
  const hist = S.home ? path.join(S.home, '.claude-server-commander', 'tool-history.jsonl') : null;
  const rawHistory = hist && fs.existsSync(hist) ? fs.readFileSync(hist, 'utf8').trim().split('\n').slice(-15) : [];
  const sc = S.scenario;
  let nextLabel = null;
  if (sc) {
    const st = sc.steps[S.cursor.step];
    nextLabel = !st ? 'finished' : st.restart ? 'close window (restart)' : st.fs ? 'filesystem change' : `${st.session}: ${st.calls[S.cursor.call].tool}`;
  }
  const rel = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (typeof x === 'string' && S.home ? x.split(S.home).join('~') : x)));
  return rel({
    dry: DRY, home: S.home, now: S.now.toISOString(), connected: !!S.conn, client: S.client,
    hasServerTool: S.tools.includes('get_device_context'),
    scenario: sc ? { name: sc.name, description: sc.description, next: nextLabel } : null,
    log: S.log.slice(-60), files: files(),
    context: ctx ? { text: ctx.text, tokens: ctx.approxTokens } : null,
    ranking: ctx ? ctx.ranking.map((r) => ({ root: r.root, activeDays: r.activeDays, dayScore: r.dayScore, multiplier: r.multiplier, score: r.score, last: new Date(r.last).toISOString(), exists: fs.existsSync(r.root) })) : [],
    journalCount: S.journal.length, droppedCount: S.dropped.length,
    rawHistory, scenarios: scenarios(),
  });
}

// ---------- HTTP ----------
const PAGE = fs.readFileSync(path.join(HERE, 'ui.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/state') return send(200, state());
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    let body = ''; for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    switch (req.url) {
      case '/api/reset': await reset(); break;
      case '/api/connect': if (!S.home) await reset(); await connect(b.client); break;
      case '/api/disconnect': await disconnect(); S.log.push({ marker: 'window closed (server stopped)' }); break;
      case '/api/call': await callTool(b.tool, b.args); break;
      case '/api/clock': S.now = b.at ? new Date(b.at) : new Date(S.now.getTime() + Number(b.shiftMs ?? 0)); S.log.push({ marker: `clock → ${S.now.toISOString()}` }); break;
      case '/api/scenario/load': await loadScenario(b.file); break;
      case '/api/scenario/next': await nextStep(); break;
      case '/api/scenario/run': { let guard = 500; while (guard-- > 0) { const r = await nextStep(); if (r.done) break; } break; }
      default: return send(404, { error: 'not found' });
    }
    return send(200, state());
  } catch (e) {
    return send(500, { error: e.message, stack: String(e.stack ?? '') });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Device context sandbox UI: http://localhost:${PORT}${DRY ? '  (dry run: real server not started' + (fs.existsSync(DIST) ? '' : ' — dist/index.js not found, run npm run build') + ')' : ''}`);
});
const shutdown = async () => { await disconnect(); if (S.root) { try { fs.rmSync(S.root, { recursive: true, force: true }); } catch { /* ignore */ } } process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
