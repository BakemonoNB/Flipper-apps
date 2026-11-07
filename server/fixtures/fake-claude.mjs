#!/usr/bin/env node
// Faux « claude -p » pour les tests : vérifie les options, appelle l'outil ping via le vrai serveur MCP,
// puis émet des évènements stream-json comme Claude Code.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const prompt = readFileSync(0, 'utf8');

for (const required of ['-p', '--strict-mcp-config', '--verbose']) {
  if (!args.includes(required)) { process.stderr.write('option manquante ' + required + '\n'); process.exit(2); }
}
if (!opt('--allowedTools').split(',').includes('mcp__flipper__ping')) { process.stderr.write('ping non autorisé\n'); process.exit(2); }
if (!opt('--disallowedTools').split(',').includes('Bash')) { process.stderr.write('Bash non interdit\n'); process.exit(2); }
if (prompt.includes('ÉCHEC')) { process.stderr.write('erreur simulée\n'); process.exit(1); }

const resumed = opt('--resume');
const session = resumed || 'sess-1';
out({ type: 'system', subtype: 'init', session_id: session });

// Démarre le serveur MCP décrit dans la config et appelle ping.
const cfg = JSON.parse(readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.flipper;
const mcp = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: mcp.stdout });
const waiting = new Map();
rl.on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
let n = 0;
const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await rpc('tools/list', {});
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__flipper__ping', input: {} }] } });
const call = await rpc('tools/call', { name: 'ping', arguments: {} });
mcp.kill();
const text = call.result.content[0].text;
out({ type: 'assistant', message: { content: [{ type: 'text', text: (resumed ? '[reprise ' + resumed + '] ' : '') + 'outils=' + list.result.tools.map((t) => t.name).join(',') + ' proto=' + init.result.protocolVersion + ' ping=' + text + (call.result.isError ? ' (erreur)' : '') }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: session });
