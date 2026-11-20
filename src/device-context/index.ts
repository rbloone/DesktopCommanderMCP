/**
 * Device context — wiring for server.ts.
 *
 * Mode (env DESKTOP_COMMANDER_DEVICE_CONTEXT): off (default) | tool | nudge | both
 *   tool  = A: the get_device_context tool (+ one line in server instructions)
 *   nudge = B: append a short block to a tool result when the agent looks for a project blindly
 *   both  = A + B
 * Journal: ~/.claude-server-commander/device-context-events.jsonl (append-only, one clean row per touched project file;
 * no file contents, no command text, no secrets). Debug log of every decision when
 * DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG=1: device-context-debug.jsonl next to it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { observeEvent, rank, render, renderCompact, renderTargeted, keyOf, type JournalRow } from './core.js';
import { classify, matchProjects, didYouMean, episodeFor } from './nudge.js';
import { capture } from '../utils/capture.js';

export type DeviceContextMode = 'off' | 'tool' | 'nudge' | 'both';

export function deviceContextMode(): DeviceContextMode {
    const v = String(process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT || 'off').toLowerCase();
    return v === 'tool' || v === 'nudge' || v === 'both' ? v : (v === '1' || v === 'true' || v === 'on' ? 'both' : 'off');
}
export const isDeviceContextToolEnabled = () => ['tool', 'both'].includes(deviceContextMode());
const isNudgeEnabled = () => ['nudge', 'both'].includes(deviceContextMode());
const isEnabled = () => deviceContextMode() !== 'off';
const debugOn = () => process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG === '1';

const home = () => process.env.DC_DEVICE_CONTEXT_HOME || os.homedir();
const dir = () => path.join(home(), '.claude-server-commander');
const journalFile = () => path.join(dir(), 'device-context-events.jsonl');
const debugFile = () => path.join(dir(), 'device-context-debug.jsonl');
const now = () => (process.env.DC_DEVICE_CONTEXT_NOW ? new Date(process.env.DC_DEVICE_CONTEXT_NOW) : new Date());

/** Desktop Commander's own install folder is never a "project". */
const excludeRoots = (() => {
    try { return [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')]; } catch { return []; }
})();

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

function appendLines(file: string, rows: object[]): void {
    if (!rows.length) return;
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.promises.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.promises.appendFile(file, text, 'utf8'))
        .catch(() => { /* never break a tool call */ });
}

function readJournal(): JournalRow[] {
    let text = '';
    try { text = fs.readFileSync(journalFile(), 'utf8'); } catch { return []; }
    if (text.length > MAX_JOURNAL_BYTES) text = text.slice(text.length - MAX_JOURNAL_BYTES); // newest 2 MB is plenty
    const rows: JournalRow[] = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (r && r.root && r.t) rows.push(r); } catch { /* skip a torn line */ }
    }
    return rows;
}

const isUiCall = (args: any) => !!(args && typeof args === 'object' && args.origin === 'ui');
const chatIdOf = (meta: any): string | null => {
    const v = meta && typeof meta === 'object' ? (meta['openai/session'] ?? meta.chatId ?? meta.conversationId) : null;
    return typeof v === 'string' && v ? v : null;
};

/** Hook after a call ran: record which project it touched. Fire-and-forget, never throws. */
export function observeToolCall(name: string, args: any, result: any, isRemote: boolean): void {
    if (!isEnabled() || name === 'get_device_context' || isUiCall(args) || result?.isError) return;
    try {
        const { journal, dropped } = observeEvent({ t: now().toISOString(), tool: name, args, origin: isRemote ? 'remote' : 'local' },
            { home: home(), excludeRoots });
        appendLines(journalFile(), journal);
        if (debugOn() && dropped.length) appendLines(debugFile(), dropped.map((d) => ({ ...d, event: 'dropped' })));
    } catch { /* ignore */ }
}

/** A: the get_device_context tool. */
export function handleGetDeviceContext(args: any, meta: any): { content: Array<{ type: 'text'; text: string }> } {
    const ep = episodeFor(chatIdOf(meta));
    ep.contextTool = true;
    ep.lastCallAt = Date.now();
    const ranking = rank(readJournal(), now());
    const q = typeof args?.project === 'string' ? args.project.trim().toLowerCase() : '';
    const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20);
    let text: string;
    if (q) {
        const hit = ranking.find((r) => keyOf(r.root) === keyOf(q)) ?? matchProjects(ranking, [q, ...q.split(/[\s/\\]+/)])[0];
        text = render(ranking, { now: now(), home: home(), limit, project: hit?.root ?? q });
    } else {
        text = render(ranking, { now: now(), home: home(), limit });
    }
    capture('server_device_context_tool', { has_project_arg: String(!!q), projects_known: ranking.length });
    if (debugOn()) appendLines(debugFile(), [{ t: new Date().toISOString(), event: 'tool', tool: 'get_device_context', text }]);
    return { content: [{ type: 'text', text }] };
}

/** One line for server instructions (clients that read them). */
export function deviceContextInstructions(): string {
    return isDeviceContextToolEnabled()
        ? '\n- In a new conversation, get_device_context lists the projects recently worked on on this device; it is cheaper than listing or searching directories to find them.'
        : '';
}

/**
 * B: after a call ran, maybe append a short device-context block to its result.
 * Returns a NEW result object (the original may already be queued for the history file).
 */
export function maybeAppendDeviceContext(name: string, args: any, result: any, meta: any): any {
    const ep = isEnabled() ? episodeFor(chatIdOf(meta)) : null;
    try {
        if (!ep || !isNudgeEnabled() || isUiCall(args) || name === 'get_device_context' || !result || !Array.isArray(result.content)) return result;
        if (result.structuredContent) return result; // keep widget/structured results untouched
        const cls = classify(name, args, result);
        let block: string | null = null;
        let type: 'general' | 'targeted' | null = null;
        if (cls.kind === 'exact') {
            ep.located = true;
        } else if (cls.kind === 'partial' || cls.kind === 'none') {
            const ranking = rank(readJournal(), now());
            const matched = cls.kind === 'partial' ? matchProjects(ranking, cls.terms).filter((r) => !ep.targeted.has(keyOf(r.root))) : [];
            if (matched.length) {
                const dym = cls.notFound ? matched.map((r) => didYouMean(cls.paths, r, fs.existsSync)).find(Boolean) ?? null : null;
                const fresh = !ep.general || !!dym || matched.some((r) => !ranking.slice(0, 5).includes(r));
                if (fresh) {
                    matched.forEach((r) => ep.targeted.add(keyOf(r.root)));
                    block = renderTargeted(matched, { now: now(), term: cls.terms.find((t) => matched.some((r) => path.basename(r.root).toLowerCase().includes(t))) ?? cls.terms[0], didYouMean: dym });
                    type = 'targeted';
                }
            } else if (cls.discovery && !ep.general && !ep.contextTool && !ep.located) {
                block = renderCompact(ranking, { now: now(), limit: 5, toolAvailable: isDeviceContextToolEnabled() });
                if (block) { ep.general = true; type = 'general'; }
            }
        }
        if (debugOn() && cls.kind !== 'skip') {
            appendLines(debugFile(), [{ t: new Date().toISOString(), event: 'decision', tool: name, case: cls.kind, reason: cls.reason,
                terms: cls.terms.slice(0, 8), episode: ep.key, episodeStartedAt: new Date(ep.startedAt).toISOString(), appended: type, text: block }]);
        }
        if (!block) return result;
        capture('server_device_context_injected', { trigger_tool: name, case: cls.kind, block_type: type, chars: block.length });
        const content = [...result.content];
        const first = content[0];
        if (first && first.type === 'text') content[0] = { ...first, text: `${first.text ?? ''}\n\n---\n${block}` };
        else content.push({ type: 'text', text: block });
        return { ...result, content };
    } catch {
        return result;
    } finally {
        if (ep) ep.lastCallAt = Date.now();
    }
}
