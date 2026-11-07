#!/usr/bin/env node
// Serveur MCP (stdio, JSON-RPC 2.0, un message par ligne) qui expose les outils Flipper à Claude Code.
// Chaque appel passe par l'API du pont : FLIPPER_API_URL (http://127.0.0.1:3040) + API_TOKEN.
import { createInterface } from 'node:readline';
import { TOOLS } from './tools.js';

const API = (process.env.FLIPPER_API_URL || 'http://127.0.0.1:3040').replace(/\/$/, '');
const TOKEN = process.env.API_TOKEN || '';
const ORIGIN = process.env.FLIPPER_ORIGIN || 'api';
const DEFAULT_PROTOCOL = '2025-06-18';

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(name, args) {
  const res = await fetch(API + '/api/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-flipper-token': TOKEN },
    body: JSON.stringify({ tool: name, args, origin: ORIGIN }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || ('HTTP ' + res.status) };
  return body;
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'flipper', version: '1.0.0' },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, 'outil inconnu : ' + name);
      const r = await callTool(name, (params && params.arguments) || {});
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(r.ok ? r.result : { erreur: r.error }) }],
        isError: !r.ok,
      });
    }
    default:
      if (isRequest) return fail(id, -32601, 'méthode inconnue : ' + method);
      return undefined; // notification (ex. notifications/initialized) : rien à répondre
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'JSON invalide'); }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
});
