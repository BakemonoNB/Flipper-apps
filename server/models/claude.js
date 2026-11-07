// Lance Claude Code en mode non interactif (claude -p) et relaie ses évènements.
// Seuls les outils Flipper (serveur MCP local) sont autorisés explicitement. La lecture de fichiers reste
// celle par défaut de Claude Code : limitée au dossier de travail (guide + types du SDK JS). Ne PAS ajouter
// Read/Glob/Grep sans chemin : Claude pourrait lire /proc/self/environ (jeton OAuth) ou la config MCP (API_TOKEN).
import { spawn } from 'node:child_process';

const MCP_PREFIX = 'mcp__flipper__';
const DENIED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

// onEvent({event:'text', text}) | onEvent({event:'tool', tool, args})
// Résout {sessionId}. Rejette avec une Error lisible.
export function runClaude({ bin = 'claude', model = '', text, sessionId = null, systemPrompt, mcpConfigPath,
  toolNames, cwd, timeoutMs = 300000, onEvent }) {
  const allowed = toolNames.map((n) => MCP_PREFIX + n);
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--allowedTools', allowed.join(','),
    '--disallowedTools', DENIED.join(','),
    '--append-system-prompt', systemPrompt,
  ];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error('Claude introuvable : ' + e.message));
      return;
    }
    let out = '';
    let errTail = '';
    let newSession = sessionId;
    let result = null;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Claude n\'a pas répondu en ' + Math.round(timeoutMs / 1000) + ' s'));
    }, timeoutMs);

    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) newSession = ev.session_id;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) onEvent({ event: 'text', text: block.text });
          else if (block.type === 'tool_use') {
            const tool = String(block.name || '').startsWith(MCP_PREFIX) ? block.name.slice(MCP_PREFIX.length) : String(block.name);
            onEvent({ event: 'tool', tool, args: block.input || {} });
          }
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    };

    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        handleLine(out.slice(0, i));
        out = out.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-2000); });
    child.on('error', (e) => finish(new Error('Claude introuvable ou non exécutable : ' + e.message)));
    child.on('close', (code) => {
      if (out) handleLine(out);
      if (result && !result.is_error && result.subtype === 'success') return finish(null, { sessionId: newSession });
      const why = (result && (result.result || result.subtype)) || errTail.trim().split('\n').slice(-3).join(' ') || ('code de sortie ' + code);
      finish(new Error('Claude a échoué : ' + String(why).slice(0, 400)));
    });

    child.stdin.end(text);
  });
}
