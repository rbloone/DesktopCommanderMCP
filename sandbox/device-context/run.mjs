#!/usr/bin/env node
// Device-context sandbox runner.
//
//   node sandbox/device-context/run.mjs                 # run all scenarios against the built server
//   node sandbox/device-context/run.mjs 01              # run scenarios whose file name starts with "01"
//   node sandbox/device-context/run.mjs --dry-run       # no server: only the prototype pipeline
//   node sandbox/device-context/run.mjs --keep          # keep the fake HOME folders for inspection
//
// For each scenario it creates a throwaway HOME with fake projects, starts the
// built Desktop Commander (dist/index.js) with HOME/USERPROFILE pointing there,
// plays the scripted tool calls session by session (a "restart" step = new
// server process = new chat window), and writes an HTML report showing what the
// server recorded and exactly what an agent would receive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeHome, FAKE_STRIPE_KEY } from './fake-home.mjs';
import { observe, contextFrom } from './preview.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist', 'index.js');
const OUT = path.join(HERE, 'out');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const KEEP = argv.includes('--keep');
const filters = argv.filter((a) => !a.startsWith('--'));

// ---------- helpers ----------
const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = (s) => color(32, s), red = (s) => color(31, s), dim = (s) => color(2, s), bold = (s) => color(1, s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function substitute(value, vars) {
  if (typeof value === 'string') {
    value = value.replace(/\{fake_stripe_key\}/g, FAKE_STRIPE_KEY);
    return value.replace(/\{(home|dc)\}([^\s"']*)/g, (_, key, rest) => {
      const base = vars[key];
      if (!rest) return base;
      return path.join(base, ...rest.split('/').filter(Boolean));
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

function textOf(result) {
  return (result?.content ?? []).map((p) => p.text ?? (p.type ? `[${p.type}]` : '')).join('\n');
}

function check(expect, text, tokens) {
  if (!expect) return [];
  const out = [];
  for (const s of expect.contains ?? []) out.push({ ok: text.includes(s), what: `contains "${s}"` });
  for (const s of expect.notInOutput ?? []) out.push({ ok: !text.includes(s), what: `does not contain "${s}"` });
  if (expect.inTop) {
    const projectLines = text.split('\n').filter((l) => /^\d+\. `/.test(l));
    for (const p of expect.inTop) out.push({ ok: projectLines.some((l) => l.includes(p)), what: `lists project ${path.basename(p)}` });
  }
  if (expect.maxTokens) out.push({ ok: tokens <= expect.maxTokens, what: `≤ ${expect.maxTokens} tokens (got ~${tokens})` });
  return out;
}

// ---------- server connection ----------
async function connect(home, clientName, at) {
  const { Client } = await import(pathToFileURL(path.join(REPO, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')).href)
    .catch(() => import('@modelcontextprotocol/sdk/client/index.js'));
  const { StdioClientTransport } = await import(pathToFileURL(path.join(REPO, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'stdio.js')).href)
    .catch(() => import('@modelcontextprotocol/sdk/client/stdio.js'));
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    DC_DEVICE_CONTEXT_NOW: at, // read by the server-side feature once it exists
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST, '--no-onboarding'],
    env,
    cwd: path.dirname(DIST), // like the remote device: the server runs from its own folder
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 30_000 });
  const tools = (await client.listTools()).tools.map((t) => t.name);
  return { client, tools, stderr };
}

// ---------- one scenario ----------
async function runScenario(file) {
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = path.basename(file, '.json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dc-sandbox-${id}-`));
  const home = path.join(root, 'home');
  const firstAt = scenario.steps.find((s) => s.at)?.at;
  const created = createFakeHome(home, { now: new Date(firstAt ?? Date.now()) });
  const vars = { home, dc: REPO };

  const journal = [];  // clean rows the feature would store
  const dropped = [];  // what the filter refused, with the reason
  const calls = [];    // full trace for the report
  const contexts = []; // every get_device_context answer
  let conn = null;
  let serverLog = '';

  console.log(`\n${bold(scenario.name)} ${dim(`(${id})`)}`);
  console.log(dim(`  HOME = ${home}`));

  try {
    for (const step of scenario.steps) {
      if (step.restart) {
        if (conn) { serverLog += conn.stderr.join(''); await conn.client.close().catch(() => {}); conn = null; }
        calls.push({ marker: 'restart — new server process (new chat window)' });
        continue;
      }
      if (step.fs) {
        const [from, to] = substitute(step.fs.rename, vars);
        fs.renameSync(from, to);
        calls.push({ marker: `filesystem: renamed ${path.relative(home, from)} → ${path.relative(home, to)}` });
        continue;
      }
      const start = Date.parse(step.at);
      calls.push({ marker: `session: ${step.session} · ${step.client} · ${step.at}` });
      if (!DRY && !conn) conn = await connect(home, step.client ?? 'sandbox-agent', step.at);

      for (const [i, raw] of step.calls.entries()) {
        const call = substitute(raw, vars);
        const t = new Date(start + i * 60_000).toISOString();
        const entry = { t, tool: call.tool, args: call.args };

        if (call.tool === 'get_device_context') {
          const now = new Date(t);
          const p = contextFrom(journal, dropped, { home, now, project: call.args?.project });
          let serverText = null;
          if (conn?.tools.includes('get_device_context')) {
            serverText = textOf(await conn.client.callTool({ name: 'get_device_context', arguments: call.args ?? {} }));
          }
          const shown = serverText ?? p.text;
          const tokens = Math.ceil(shown.length / 4);
          const checks = check(substitute(call.expect, vars), shown, tokens);
          contexts.push({ session: step.session, t, args: call.args, source: serverText ? 'server' : 'sandbox prototype (preview.mjs)', text: shown, tokens, checks, preview: p });
          entry.result = `→ context (${tokens} tokens, ${serverText ? 'from server' : 'from prototype'})`;
          console.log(`  ${step.session} → get_device_context${call.args?.project ? ` (project)` : ''}: ~${tokens} tokens`);
          for (const c of checks) console.log(`    ${c.ok ? green('✓') : red('✗')} ${c.what}`);
          calls.push(entry);
          continue;
        }

        let ok = true; let resultText = '(dry run: not executed)';
        if (conn) {
          try {
            const res = await conn.client.callTool({ name: call.tool, arguments: call.args ?? {} }, undefined, { timeout: 60_000 });
            ok = !res.isError; resultText = textOf(res);
          } catch (e) { ok = false; resultText = `ERROR: ${e.message}`; }
        }
        entry.ok = ok; entry.result = resultText.slice(0, 600);
        const seen = observe({ t, tool: call.tool, args: call.args, ok, origin: /chatgpt|remote/i.test(step.client ?? '') ? 'remote' : 'local' },
          { home, excludeRoots: [REPO] });
        journal.push(...seen.journal); dropped.push(...seen.dropped);
        calls.push(entry);
      }
    }
  } finally {
    if (conn) { serverLog += conn.stderr.join(''); await conn.client.close().catch(() => {}); }
  }

  // What the real server wrote on its own (raw, unfiltered)
  const histFile = path.join(home, '.claude-server-commander', 'tool-history.jsonl');
  const rawHistory = fs.existsSync(histFile) ? fs.readFileSync(histFile, 'utf8').trim().split('\n').filter(Boolean) : [];

  const allChecks = contexts.flatMap((c) => c.checks);
  const passed = allChecks.filter((c) => c.ok).length;
  console.log(`  ${allChecks.every((c) => c.ok) ? green('PASS') : red('FAIL')} ${passed}/${allChecks.length} checks`);

  fs.mkdirSync(OUT, { recursive: true });
  const reportFile = path.join(OUT, `${id}.html`);
  fs.writeFileSync(reportFile, report({ scenario, id, home, created, calls, contexts, rawHistory, serverLog, dry: DRY }));
  console.log(dim(`  report: ${reportFile}`));

  if (!KEEP) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { console.log(dim(`  (could not delete ${root})`)); } }
  else console.log(dim(`  kept: ${root}`));
  return allChecks.every((c) => c.ok);
}

// ---------- HTML report ----------
function report({ scenario, id, home, created, calls, contexts, rawHistory, serverLog, dry }) {
  const rel = (p) => (typeof p === 'string' ? p.split(home).join('~') : p);
  const relDeep = (v) => JSON.parse(JSON.stringify(v ?? {}, (k, x) => rel(x)));
  const ctxHtml = contexts.map((c, i) => {
    const p = c.preview;
    return `
    <section class="ctx">
      <h3>${i + 1}. ${esc(c.session)} — <code>get_device_context(${esc(JSON.stringify(relDeep(c.args)))})</code></h3>
      <p class="meta">at ${esc(c.t)} · ~${c.tokens} tokens · source: ${esc(c.source)}</p>
      <div class="checks">${c.checks.map((k) => `<span class="${k.ok ? 'ok' : 'bad'}">${k.ok ? '✓' : '✗'} ${esc(rel(k.what))}</span>`).join('') || '<span class="muted">no expectations</span>'}</div>
      <h4>What the agent receives</h4>
      <pre class="agent">${esc(rel(c.text))}</pre>
      <details><summary>Ranking (${p.ranking.length} projects)</summary>
        <table><tr><th>Project</th><th>Active days</th><th>Day score</th><th>Last seen</th><th>× recency</th><th>Score</th><th>On disk</th></tr>
        ${p.ranking.map((r) => `<tr><td>${esc(rel(r.root))}</td><td>${r.activeDays}</td><td>${r.dayScore}</td><td>${esc(new Date(r.last).toISOString())}</td><td>${r.multiplier}</td><td><b>${r.score}</b></td><td>${fs.existsSync(r.root) ? 'yes' : 'no'}</td></tr>`).join('')}
        </table></details>
      <details><summary>Clean journal — what would be stored (${p.journal.length} rows)</summary>
        <pre>${esc(p.journal.map((j) => JSON.stringify(relDeep(j))).join('\n'))}</pre></details>
      <details><summary>Dropped — never stored (${p.dropped.length})</summary>
        <table><tr><th>Time</th><th>Tool</th><th>Reason</th><th>Preview (redacted)</th></tr>
        ${p.dropped.map((d) => `<tr><td>${esc(d.t)}</td><td>${esc(d.tool)}</td><td>${esc(d.reason)}</td><td><code>${esc(rel(d.preview))}</code></td></tr>`).join('')}
        </table></details>
    </section>`;
  }).join('');
  const traceHtml = calls.map((c) => c.marker
    ? `<tr class="marker"><td colspan="4">${esc(c.marker)}</td></tr>`
    : `<tr><td>${esc(c.t.slice(11, 16))}</td><td><code>${esc(c.tool)}</code></td><td><code>${esc(JSON.stringify(relDeep(c.args)))}</code></td><td class="${c.ok === false ? 'bad' : ''}">${esc(rel(c.result ?? ''))}</td></tr>`).join('');
  const allChecks = contexts.flatMap((c) => c.checks);
  const pass = allChecks.every((c) => c.ok);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(scenario.name)} — device context sandbox</title>
<style>
 body{font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;max-width:1100px;margin:24px auto;padding:0 20px;color:#1f1f1d;background:#f7f6f3}
 h1{font-size:22px;margin:0} h2{font-size:17px;margin-top:32px;border-top:1px solid #ddd;padding-top:10px} h3{font-size:15px;margin:0 0 4px} h4{margin:12px 0 4px;font-size:13px;color:#555}
 code,pre{font:12.5px/1.45 ui-monospace,Consolas,monospace} pre{background:#fff;border:1px solid #e4e2dc;border-radius:8px;padding:10px 12px;overflow:auto;white-space:pre-wrap}
 pre.agent{border-left:4px solid #2f5bd3} .ctx{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:14px 16px;margin:14px 0}
 .meta,.muted{color:#6b6a66;font-size:12.5px} table{border-collapse:collapse;width:100%;margin:6px 0;background:#fff} td,th{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top;font-size:12.5px}
 tr.marker td{background:#eef1fb;font-weight:600} .ok{color:#1f7a4d} .bad{color:#b3261e} .checks span{display:inline-block;margin:2px 10px 2px 0;font-size:13px}
 .badge{display:inline-block;padding:2px 10px;border-radius:999px;color:#fff;font-weight:600;background:${pass ? '#1f7a4d' : '#b3261e'}} details{margin:6px 0} summary{cursor:pointer;color:#444}
</style></head><body>
<h1>${esc(scenario.name)} <span class="badge">${pass ? 'PASS' : 'FAIL'} ${allChecks.filter((c) => c.ok).length}/${allChecks.length}</span></h1>
<p>${esc(scenario.description ?? '')}</p>
<p class="meta">Scenario <code>${esc(id)}</code> · ${dry ? '<b>dry run</b> (server not started)' : 'server: dist/index.js'} · fake HOME shown as <code>~</code> · ${esc(created.gitMode)}<br>Fake projects: ${esc(created.projects.join(' · '))}</p>
<h2>What new chats received</h2>${ctxHtml || '<p class="muted">No get_device_context calls in this scenario.</p>'}
<h2>Session trace (tool calls the mock agent made)</h2>
<p class="meta">Input to the pipeline. Contains canary secrets on purpose — they must not appear above.</p>
<table><tr><th>Time</th><th>Tool</th><th>Arguments</th><th>Result (truncated)</th></tr>${traceHtml}</table>
<h2>Raw tool-history.jsonl written by the server (${rawHistory.length} lines)</h2>
<p class="meta">What Desktop Commander already stores today, unfiltered. Shown for comparison with the clean journal.</p>
<pre>${esc(rel(rawHistory.slice(-40).join('\n')) || '(none — dry run or server did not write history)')}</pre>
${serverLog ? `<details><summary>Server stderr</summary><pre>${esc(rel(serverLog.slice(-4000)))}</pre></details>` : ''}
</body></html>`;
}

// ---------- main ----------
const scenarioDir = path.join(HERE, 'scenarios');
const files = fs.readdirSync(scenarioDir).filter((f) => f.endsWith('.json'))
  .filter((f) => !filters.length || filters.some((x) => f.startsWith(x))).sort().map((f) => path.join(scenarioDir, f));

if (!DRY && !fs.existsSync(DIST)) {
  console.error(red(`dist/index.js not found. Run "npm install" and "npm run build" in ${REPO} first, or use --dry-run.`));
  process.exit(1);
}
if (!files.length) { console.error(red('No scenarios matched.')); process.exit(1); }

let allOk = true;
for (const f of files) {
  try { allOk = (await runScenario(f)) && allOk; }
  catch (e) { allOk = false; console.error(red(`  scenario failed to run: ${e.stack ?? e}`)); }
}
console.log(allOk ? green('\nAll scenarios passed.') : red('\nSome checks failed — open the reports in sandbox/device-context/out/.'));
process.exit(allOk ? 0 : 1);
