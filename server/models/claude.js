// Lance Claude Code en mode non interactif (claude -p) et relaie ses évènements.
// Autorisés explicitement : les outils Flipper (serveur MCP local) et la recherche web (lecture seule). La lecture de fichiers reste
// celle par défaut de Claude Code : limitée au dossier de travail (guide + types du SDK JS). Ne PAS ajouter
// Read/Glob/Grep sans chemin : Claude pourrait lire /proc/self/environ (jeton OAuth) ou la config MCP (API_TOKEN).
import { spawn } from 'node:child_process';

const MCP_PREFIX = 'mcp__flipper__';
// Web : recherche et lecture de pages (GitHub, docs). Une page peut contenir des instructions piégées :
// les actions sur le Flipper restent validées sur le téléphone (hors mode autonome).
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const DENIED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task'];

// Environnement minimal : jamais PHONE_TOKEN, API_TOKEN ni LOGS_TOKEN. Claude Code refuse aujourd'hui de lire
// /proc, mais c'est une protection interne qui peut changer : on ne lui donne simplement pas ces jetons.
// (Le serveur MCP Flipper reçoit API_TOKEN par sa propre config, pas par cet environnement.)
const KEEP_ENV = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'CLAUDE_CODE_OAUTH_TOKEN'];
export function claudeEnv(src = process.env) {
  const env = {};
  for (const k of KEEP_ENV) if (src[k]) env[k] = src[k];
  env.DISABLE_AUTOUPDATER = '1'; // le service n'a pas le droit de mettre à jour /usr/bin/claude
  return env;
}

// onEvent({event:'text', text}) | onEvent({event:'tool', tool, args})
// Résout {sessionId}. Rejette avec une Error lisible.
export function runClaude({ bin = 'claude', model = '', text, sessionId = null, systemPrompt, mcpConfigPath,
  toolNames, cwd, timeoutMs = 300000, onEvent }) {
  const allowed = toolNames.map((n) => MCP_PREFIX + n).concat(WEB_TOOLS);
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
      child = spawn(bin, args, { cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
