// Chat entre l'app téléphone et les modèles du VPS.
// Une seule réponse en cours à la fois (RAM du VPS). L'historique est gardé par modèle dans STATE_DIR.
//
// téléphone -> serveur : {type:'chat', id, model, text} ; {type:'chat_reset', model}
// serveur -> téléphone : {type:'chat_event', id, model, event:'text'|'tool'|'done'|'error', ...}
//                        {type:'chat_history', model, items:[{role, text}]}
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runClaude } from './models/claude.js';
import { runOllama } from './models/ollama.js';
import { toolNames, ollamaTools, shrinkArgs } from './tools.js';
import { screenToText } from './screen.js';

const MAX_TEXT = 4000;
const MAX_HISTORY = 100;     // entrées affichées par modèle
const MAX_OLLAMA_MSGS = 24;  // messages gardés dans le contexte de gpt-oss

// workDir : dossier de travail de Claude (documentation lisible avec Read : CLAUDE.md, types du SDK JS).
// Un tour de Claude peut enchaîner captures, compilations et corrections : 10 min max.
const CLAUDE_TIMEOUT_MS = 600000;

export function createChat({ models, systemPrompt, ollamaPrompt = systemPrompt, ollamaThink = 'medium', stateDir, workDir, mcpConfigPath,
  claudeBin, ollamaUrl, ollamaNumCtx, log, sendToPhone, callTool, contextLine = () => '' }) {
  // contextLine : ligne ajoutée au prompt à chaque message (ex. firmware actuel lu par le téléphone).
  const withContext = (p) => { const l = contextLine(); return l ? p + '\n' + l : p; };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, 'chat.json');
  let state = { conversations: {} };
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* premier démarrage */ }
  if (!state.conversations) state.conversations = {};
  let busy = null;
  // Résultats de tâches de fond à donner au modèle à son prochain message (par modèle).
  const pending = {};

  const conv = (model) => {
    if (!state.conversations[model]) state.conversations[model] = { history: [], claudeSession: null, ollamaMessages: [] };
    return state.conversations[model];
  };
  const save = () => {
    try {
      writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    } catch (e) { log('ERROR', 'historique du chat non sauvegardé : ' + e.message); }
  };
  const record = (c, role, text) => {
    c.history.push({ role, text: String(text).slice(0, 8000), at: new Date().toISOString() });
    if (c.history.length > MAX_HISTORY) c.history.splice(0, c.history.length - MAX_HISTORY);
  };

  // gpt-oss ne lit pas les images : l'écran lui est donné en texte réduit.
  async function callForText(name, args, model) {
    const r = await callTool(name, args, model);
    if (r.ok && name === 'get_screen') {
      try {
        return { ok: true, result: { ecran: screenToText(r.result, 1), note: '128x64, # = pixel allumé' } };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    return r;
  }

  function list() {
    return Object.entries(models).map(([id, m]) => ({ id, label: m.label }));
  }

  function histories() {
    return Object.keys(models).map((model) => ({ type: 'chat_history', model, items: conv(model).history }));
  }

  async function handle(msg) {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : String(Date.now());
    const model = msg.model;
    const m = Object.hasOwn(models, model) ? models[model] : null;
    const emit = (ev) => sendToPhone({ type: 'chat_event', id, model, ...ev });
    if (!m) return emit({ event: 'error', error: 'modèle inconnu' });
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text || text.length > MAX_TEXT) return emit({ event: 'error', error: 'message vide ou trop long (' + MAX_TEXT + ' caractères max)' });
    if (busy) return emit({ event: 'error', error: 'un modèle répond déjà, attends la fin' });

    busy = id;
    const c = conv(model);
    record(c, 'user', text);
    const notes = pending[model] || [];
    delete pending[model];
    const modelText = notes.length ? '[Résultats de tâches de fond terminées depuis ton dernier message : ' + notes.join(' | ') + ']\n\n' + text : text;
    let answer = '';
    const onEvent = (ev) => {
      if (ev.event === 'text') answer += ev.text;
      if (ev.event === 'tool') {
        if (answer.trim()) { record(c, 'assistant', answer); answer = ''; }
        ev = { ...ev, args: shrinkArgs(ev.args) };
        record(c, 'tool', ev.tool + ' ' + JSON.stringify(ev.args));
      }
      emit(ev);
    };
    const t0 = Date.now();
    log('INFO', 'chat ' + model + ' : début (' + text.length + ' caractères)');
    try {
      if (m.kind === 'claude') {
        try {
          const r = await runClaude({
            bin: claudeBin, model: m.model, text: modelText, sessionId: c.claudeSession, timeoutMs: CLAUDE_TIMEOUT_MS, systemPrompt: withContext(systemPrompt), mcpConfigPath,
            toolNames: toolNames(), cwd: workDir, onEvent,
          });
          c.claudeSession = r.sessionId;
        } catch (e) {
          // Délai dépassé : la session est enregistrée au fil de l'eau, on la garde (sinon Claude oublie tout).
          // Autre échec (session illisible…) : la prochaine repart de zéro.
          if (!/n'a pas répondu/.test(e.message)) c.claudeSession = null;
          throw e;
        }
      } else {
        const snapshot = c.ollamaMessages.map((m) => ({ ...m }));
        try {
          await runOllama({
            url: ollamaUrl, model: m.model, numCtx: ollamaNumCtx, think: ollamaThink, systemPrompt: withContext(ollamaPrompt), messages: c.ollamaMessages, text: modelText,
            tools: ollamaTools(), callTool: (name, args) => callForText(name, args, model), onEvent,
          });
        } catch (e) {
          c.ollamaMessages.splice(0, c.ollamaMessages.length, ...snapshot); // on oublie le tour raté
          throw e;
        }
        if (c.ollamaMessages.length > MAX_OLLAMA_MSGS) c.ollamaMessages.splice(0, c.ollamaMessages.length - MAX_OLLAMA_MSGS);
        while (c.ollamaMessages.length && c.ollamaMessages[0].role !== 'user') c.ollamaMessages.shift();
      }
      if (answer.trim()) record(c, 'assistant', answer);
      emit({ event: 'done' });
      log('INFO', 'chat ' + model + ' : fin en ' + Math.round((Date.now() - t0) / 1000) + ' s');
    } catch (e) {
      if (answer.trim()) record(c, 'assistant', answer);
      record(c, 'error', e.message);
      emit({ event: 'error', error: e.message });
      log('ERROR', 'chat ' + model + ' : ' + e.message);
    } finally {
      busy = null;
      save();
    }
  }

  // Fin d'une tâche de fond lancée par ce modèle : bulle dans le chat + note pour son prochain message.
  function notice(model, text) {
    if (!Object.hasOwn(models, model)) return;
    record(conv(model), 'notice', text);
    (pending[model] = pending[model] || []).push(String(text).slice(0, 600));
    sendToPhone({ type: 'chat_event', id: 'notice', model, event: 'notice', text });
    save();
  }

  function reset(model) {
    if (!Object.hasOwn(models, model)) return;
    state.conversations[model] = { history: [], claudeSession: null, ollamaMessages: [] };
    save();
    sendToPhone({ type: 'chat_history', model, items: [] });
    log('INFO', 'chat ' + model + ' : nouvelle conversation');
  }

  return { handle, reset, list, histories, notice };
}
