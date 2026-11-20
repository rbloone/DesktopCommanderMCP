#!/usr/bin/env node
// Offline test for chatgpt-probe.mjs: plays scripted "agent" call sequences against the probe
// and checks when the device-context block is (not) appended. No ChatGPT, no tunnel needed.
//   node sandbox/device-context/chatgpt-probe.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = '/home/roman';
let failures = 0, passes = 0;

async function withProbe(mode, fn) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(HERE, 'chatgpt-probe.mjs')], {
    env: { ...process.env, MODE: mode, PORT: String(port), PROBE_TEST: '1', PROBE_LOG: path.join(os.tmpdir(), `probe-test-${port}.jsonl`) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res) => child.stdout.on('data', (d) => String(d).includes('listening') && res()));
  const url = `http://localhost:${port}`;
  let id = 0;
  const rpc = async (method, params) => (await (await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json());
  const call = async (chat, name, args) => {
    const r = await rpc('tools/call', { name, arguments: args, _meta: chat ? { 'openai/session': chat } : {} });
    const text = r.result.content[0].text;
    const block = text.includes('---\n[Desktop Commander device context') ? text.slice(text.indexOf('---\n[Desktop Commander')) : '';
    return { text, block, kind: !block ? 'none' : block.includes('Recently active projects') ? 'general' : 'targeted' };
  };
  const advance = (ms) => fetch(`${url}/_probe/advance?ms=${ms}`, { method: 'POST' });
  const stats = async () => (await (await fetch(`${url}/_probe/stats`)).json());
  try { await fn({ rpc, call, advance, stats }); } finally { child.kill('SIGTERM'); }
}

function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

console.log('MODE=both');
await withProbe('both', async ({ rpc, call, advance, stats }) => {
  const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  check('A: get_device_context is listed first', tools[0] === 'get_device_context', tools.join(','));

  console.log(' chat A: blind ls ~ -> general, then straight to crm');
  let r = await call('A', 'list_directory', { path: '~' });
  check('ls ~ appends general top-5', r.kind === 'general', r.block);
  check('top-5 lists /srv/crm first', r.block.split('\n')[3]?.includes(`${H}/srv/crm `));
  check('decoy backup-crm is not listed as a project', !r.block.includes('backup-crm'));
  r = await call('A', 'list_directory', { path: `${H}/srv` });
  check('second broad listing in same chat appends nothing', r.kind === 'none');
  r = await call('A', 'read_file', { path: `${H}/srv/crm/app/settings.py` });
  check('exact project path appends nothing', r.kind === 'none' && r.text.includes('RETRY_LIMIT = 5'));

  console.log(' chat B: search "crm" -> targeted line');
  r = await call('B', 'start_search', { path: '~', pattern: 'crm' });
  check('search for a project name appends targeted block', r.kind === 'targeted', r.block);
  check('exact name first, crm-mobile as weaker match', r.block.indexOf(`${H}/srv/crm `) < r.block.indexOf('crm-mobile'));
  r = await call('B', 'list_directory', { path: '~' });
  check('later ls ~ in same chat still gets general (crm already shown, others not)', r.kind === 'general');

  console.log(' chat C: guessed path ~/projects/crm/... -> did you mean');
  r = await call('C', 'read_file', { path: '~/projects/crm/app/settings.py' });
  check('not-found guessed path appends targeted + did-you-mean', r.kind === 'targeted' && r.block.includes(`Did you mean: ${H}/srv/crm/app/settings.py`), r.block);

  console.log(' chat D: agent already knows the path');
  r = await call('D', 'read_file', { path: `${H}/srv/crm/AGENTS.md` });
  check('first call inside project appends nothing', r.kind === 'none');
  r = await call('D', 'list_directory', { path: '~' });
  check('after locating, ls ~ appends nothing', r.kind === 'none');

  console.log(' chat E: false-positive guards');
  r = await call('E', 'list_directory', { path: '~/Downloads' });
  check('ls ~/Downloads (tidying) appends nothing', r.kind === 'none');
  r = await call('E', 'read_file', { path: '~/notes.txt' });
  check('reading a known non-project file appends nothing', r.kind === 'none');

  console.log(' chat F: shell exploration');
  r = await call('F', 'start_process', { command: 'find ~ -name settings.py' });
  check('find from home appends general', r.kind === 'general', r.block);
  console.log(' chat G: guessed dir with no matching name');
  r = await call('G', 'start_process', { command: 'ls ~/code' });
  check('ls of missing ~/code appends general', r.kind === 'general');

  console.log(' chat H: model called A first');
  r = await call('H', 'get_device_context', {});
  check('get_device_context returns the list', r.text.includes(`${H}/srv/crm`));
  r = await call('H', 'list_directory', { path: '~' });
  check('after A, ls ~ appends nothing (no duplicate)', r.kind === 'none');

  console.log(' no chat id: 10-minute episodes');
  r = await call(null, 'list_directory', { path: '~' });
  check('first ls ~ appends general', r.kind === 'general');
  r = await call(null, 'list_directory', { path: '/' });
  check('second blind call within episode appends nothing', r.kind === 'none');
  await advance(5 * 60_000);
  r = await call(null, 'list_directory', { path: '~' });
  check('5 min later (same episode) appends nothing', r.kind === 'none');
  await advance(11 * 60_000);
  r = await call(null, 'list_directory', { path: '~' });
  check('after 11 min idle -> new episode -> general again', r.kind === 'general');

  const s = await stats();
  const a = s.find((x) => x.chat === 'A');
  check('stats: chat A found target at call 3', a?.foundTargetAtCall === 3, JSON.stringify(a));
});

console.log('MODE=off');
await withProbe('off', async ({ rpc, call }) => {
  const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  check('no get_device_context tool', !tools.includes('get_device_context'));
  const r = await call('A', 'list_directory', { path: '~' });
  check('nothing appended', r.kind === 'none');
});

console.log('MODE=tool');
await withProbe('tool', async ({ rpc, call }) => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  check('instructions mention get_device_context', /get_device_context/.test(init.result.instructions || ''));
  const r = await call('A', 'list_directory', { path: '~' });
  check('nothing appended (A only)', r.kind === 'none');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
