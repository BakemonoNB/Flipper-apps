import { Flipper, Key, InputType, SCREEN_W, SCREEN_H, pixelOn } from './flipper.js';
import { BridgeClient } from './bridge.js';

const $ = (id) => document.getElementById(id);
const flipper = new Flipper();
const bridge = new BridgeClient();
const DEFAULT_VPS_URL = 'wss://nova.astrae.tech/flipper/ws';
const SETTINGS_KEY = 'flipper-bridge';
const LONG_MS = 500;     // au-delà : appui long
const REPEAT_MS = 150;   // répétition des flèches pendant un appui long
const ON = [0, 0, 0];
const OFF = [255, 130, 0];

let battery = null;
let busy = null;

// ---------- Journal ----------
const logEl = $('log');
function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = new Date().toLocaleTimeString('fr-FR') + '  ' + msg;
  logEl.appendChild(line);
  while (logEl.childElementCount > 300) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- Écran ----------
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(SCREEN_W, SCREEN_H);
let frames = 0;
let warnedOrientation = false;

function paint(isOn) {
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const c = isOn(x, y) ? ON : OFF;
      const i = (y * SCREEN_W + x) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawFrame(data, orientation) {
  if (orientation >= 2 && !warnedOrientation) {
    warnedOrientation = true;
    log('Écran en orientation verticale : affiché sans rotation.');
  }
  const flip = orientation === 1;
  paint((x, y) => flip ? pixelOn(data, SCREEN_W - 1 - x, SCREEN_H - 1 - y) : pixelOn(data, x, y));
  frames++;
}

setInterval(() => {
  $('fps').textContent = flipper.connected ? frames + ' img/s' : '';
  frames = 0;
}, 1000);

// ---------- État ----------
function render() {
  const connected = flipper.connected;
  const main = $('main');
  main.textContent = connected ? 'Déconnecter' : flipper.device ? 'Reconnecter' : 'Connecter';
  main.disabled = !!busy;
  const status = $('status');
  status.textContent = busy || (connected
    ? flipper.name + (battery != null ? ' · ' + battery + ' %' : '')
    : 'Flipper déconnecté');
  status.className = 'status' + (connected ? ' on' : '');
  const vps = $('vpsStatus');
  vps.textContent = 'VPS : ' + VPS_LABELS[bridge.status];
  vps.className = 'status small' + (bridge.status === 'online' ? ' on' : bridge.status === 'refused' ? ' bad' : '');
  document.body.classList.toggle('connected', connected);
  $('other').hidden = connected;
  for (const b of document.querySelectorAll('[data-key]')) b.disabled = !connected;
}

async function withBusy(msg, fn) {
  busy = msg;
  render();
  try {
    await fn();
  } catch (e) {
    log('Échec : ' + (e && e.message ? e.message : e), 'err');
  } finally {
    busy = null;
    render();
  }
}

// ---------- Connexion ----------
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator)) {
    log("Garde l'écran allumé : iOS coupe le Bluetooth quand le téléphone se verrouille.");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    log('Mise en veille non bloquée : ' + e.message);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && flipper.connected && !wakeLock) keepAwake();
});

async function connectFlow() {
  await flipper.connect();
  battery = await flipper.battery();
  log('Connecté à ' + flipper.name + (battery != null ? ' (batterie ' + battery + ' %)' : ''), 'ok');
  render();
  sendState();
  keepAwake();
  try {
    await flipper.startScreen();
    log('Écran en direct activé.', 'ok');
  } catch (e) {
    log('Écran en direct impossible : ' + e.message, 'err');
  }
}

$('main').addEventListener('click', () => {
  if (flipper.connected) { flipper.disconnect(); return; }
  // requestDevice doit partir directement du tap : pas d'await avant pick().
  const picking = flipper.device ? Promise.resolve() : flipper.pick();
  withBusy('Connexion…', async () => { await picking; await connectFlow(); });
});

$('other').addEventListener('click', () => {
  const picking = flipper.pick({ all: true });
  withBusy('Connexion…', async () => { await picking; await connectFlow(); });
});

flipper.addEventListener('screen', (e) => drawFrame(e.detail.data, e.detail.orientation));
flipper.addEventListener('disconnected', () => {
  log('Déconnecté.', 'err');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  render();
  sendState();
});
flipper.addEventListener('error', (e) => log('Erreur de flux : ' + e.detail.message, 'err'));
flipper.addEventListener('unsolicited', (e) =>
  log('Message non attendu : id=' + e.detail.id + ' champs=' + e.detail.fields.map((f) => f.field).join(',')));

// ---------- Boutons ----------
const ARROWS = new Set([Key.UP, Key.DOWN, Key.LEFT, Key.RIGHT]);

for (const btn of document.querySelectorAll('[data-key]')) {
  const key = Key[btn.dataset.key];
  let down = false, longSent = false, longTimer = null, repeatTimer = null;
  const send = (type) => flipper.input(key, type).catch((e) => log('Bouton ' + btn.dataset.key + ' : ' + e.message, 'err'));

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!flipper.connected || down) return;
    down = true;
    longSent = false;
    if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId);
    btn.classList.add('active');
    if (navigator.vibrate) navigator.vibrate(10);
    send(InputType.PRESS);
    longTimer = setTimeout(() => {
      longSent = true;
      send(InputType.LONG);
      if (ARROWS.has(key)) repeatTimer = setInterval(() => send(InputType.REPEAT), REPEAT_MS);
    }, LONG_MS);
  });

  const up = () => {
    if (!down) return;
    down = false;
    clearTimeout(longTimer);
    clearInterval(repeatTimer);
    btn.classList.remove('active');
    if (!longSent) send(InputType.SHORT);
    send(InputType.RELEASE);
  };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- Pont VPS ----------
const VPS_LABELS = {
  off: 'non configuré',
  connecting: 'connexion…',
  online: 'connecté',
  refused: 'jeton refusé',
  replaced: 'pris par un autre appareil',
  offline: 'hors ligne, nouvel essai…',
};

// Outils que le VPS peut demander. Le niveau est décidé ICI, jamais par le message du serveur.
// Niveaux : read (sans validation) ; write, action, emit : validation sur le téléphone (étape 5).
const TOOLS = {
  ping: { level: 'read', run: async () => ({ latencyMs: Math.round(await flipper.ping()) }) },
};

async function handleCall({ id, tool, args }) {
  const t = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : null;
  const fail = (msg) => { log('VPS → ' + tool + ' refusé : ' + msg, 'err'); bridge.reply(id, false, msg); };
  if (!t) return fail('outil inconnu sur le téléphone');
  if (t.level !== 'read') return fail('validation pas encore disponible');
  if (!flipper.connected) return fail('Flipper non connecté au téléphone');
  try {
    const result = await t.run(args);
    log('VPS → ' + tool + ' : OK', 'ok');
    bridge.reply(id, true, result);
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

function sendState() {
  bridge.send({
    type: 'state',
    state: { flipper: { connected: flipper.connected, name: flipper.name, battery: flipper.connected ? battery : null } },
  });
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { url: typeof s.url === 'string' && s.url ? s.url : DEFAULT_VPS_URL, token: typeof s.token === 'string' ? s.token : '' };
  } catch {
    return { url: DEFAULT_VPS_URL, token: '' };
  }
}

function saveSettings(s) {
  // Le jeton reste dans ce navigateur, sur ce téléphone.
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

bridge.addEventListener('status', (e) => {
  const st = e.detail;
  if (st === 'online') { log('VPS connecté.', 'ok'); sendState(); }
  else if (st === 'refused') log('VPS : jeton refusé. Vérifie le jeton dans « Serveur VPS ».', 'err');
  else if (st === 'replaced') log('VPS : un autre appareil s\'est connecté avec ce jeton.', 'err');
  render();
});
bridge.addEventListener('call', (e) => { handleCall(e.detail); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') bridge.wake(); });

$('vpsSave').addEventListener('click', () => {
  const url = $('vpsUrl').value.trim() || DEFAULT_VPS_URL;
  const token = $('vpsToken').value.trim();
  if (!/^wss:\/\//.test(url)) { log('L\'adresse du VPS doit commencer par wss://', 'err'); return; }
  if (!saveSettings({ url, token })) log('Réglages non mémorisés (stockage indisponible) : valables jusqu\'à la fermeture.', 'err');
  bridge.configure(url, token);
  log(token ? 'Réglages VPS enregistrés.' : 'Jeton vide : pont VPS désactivé.');
});

{
  const s = loadSettings();
  $('vpsUrl').value = s.url;
  $('vpsToken').value = s.token;
  bridge.configure(s.url, s.token);
}

// ---------- Chat ----------
const CHAT_MODEL_KEY = 'flipper-chat-model';
const chat = { models: [], histories: {}, current: null, live: null }; // live : {id, model} pendant une réponse

function chatControls() {
  const online = bridge.status === 'online';
  $('chatSend').disabled = !online || !!chat.live || !chat.current;
  $('chatReset').disabled = !online || !!chat.live || !chat.current;
  $('chatModel').disabled = !!chat.live;
  $('chatText').placeholder = online ? 'Demande au modèle…' : 'VPS non connecté';
}

function renderChat() {
  const box = $('chatLog');
  box.textContent = '';
  const items = chat.histories[chat.current] || [];
  if (!items.length && !(chat.live && chat.live.model === chat.current)) {
    const p = document.createElement('p');
    p.className = 'chat-empty';
    p.textContent = chat.models.length ? 'Aucun message.' : 'Connecte le VPS pour discuter avec les modèles.';
    box.appendChild(p);
  }
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'msg ' + (['user', 'assistant', 'tool', 'error'].includes(it.role) ? it.role : 'assistant');
    d.textContent = it.role === 'tool' ? 'outil : ' + it.text : it.text;
    box.appendChild(d);
  }
  if (chat.live && chat.live.model === chat.current) {
    const last = items[items.length - 1];
    if (!last || last.role !== 'assistant') {
      const w = document.createElement('div');
      w.className = 'msg wait';
      w.textContent = 'réflexion…';
      box.appendChild(w);
    }
  }
  box.scrollTop = box.scrollHeight;
  chatControls();
}

function pushChat(model, role, text) {
  const h = chat.histories[model] || (chat.histories[model] = []);
  const last = h[h.length - 1];
  // Le texte d'une réponse arrive en morceaux : on les recolle dans la même bulle.
  if (role === 'assistant' && last && last.role === 'assistant' && last.live) last.text += text;
  else h.push({ role, text, live: role === 'assistant' });
  if (h.length > 200) h.splice(0, h.length - 200);
}

function setModels(models) {
  chat.models = Array.isArray(models) ? models : [];
  const sel = $('chatModel');
  sel.textContent = '';
  for (const m of chat.models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  let saved = null;
  try { saved = localStorage.getItem(CHAT_MODEL_KEY); } catch { /* stockage indisponible */ }
  chat.current = chat.models.some((m) => m.id === saved) ? saved : (chat.models[0] ? chat.models[0].id : null);
  if (chat.current) sel.value = chat.current;
  renderChat();
}

bridge.addEventListener('message', (e) => {
  const m = e.detail;
  if (m.type === 'welcome') {
    setModels(m.models);
  } else if (m.type === 'chat_history') {
    if (chat.live && chat.live.model === m.model) return; // une réponse est en cours : on garde l'affichage local
    chat.histories[m.model] = (m.items || []).map((it) => ({ role: it.role, text: it.text }));
    if (m.model === chat.current) renderChat();
  } else if (m.type === 'chat_event') {
    if (m.event === 'text') pushChat(m.model, 'assistant', m.text || '');
    else if (m.event === 'tool') {
      pushChat(m.model, 'tool', m.tool + ' ' + JSON.stringify(m.args || {}));
      log('Chat ' + m.model + ' → outil ' + m.tool);
    } else if (m.event === 'error') {
      pushChat(m.model, 'error', m.error || 'erreur');
      if (chat.live && chat.live.id === m.id) chat.live = null;
    } else if (m.event === 'done') {
      if (chat.live && chat.live.id === m.id) chat.live = null;
    }
    const h = chat.histories[m.model];
    if (h && (m.event === 'done' || m.event === 'error')) for (const it of h) it.live = false;
    if (m.model === chat.current) renderChat();
    else chatControls();
  }
});

$('chatModel').addEventListener('change', () => {
  chat.current = $('chatModel').value;
  try { localStorage.setItem(CHAT_MODEL_KEY, chat.current); } catch { /* stockage indisponible */ }
  renderChat();
});

$('chatSend').addEventListener('click', () => {
  const text = $('chatText').value.trim();
  if (!text || !chat.current || chat.live) return;
  const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!bridge.send({ type: 'chat', id, model: chat.current, text })) {
    log('Chat : VPS non connecté.', 'err');
    return;
  }
  chat.live = { id, model: chat.current };
  for (const it of chat.histories[chat.current] || []) it.live = false;
  pushChat(chat.current, 'user', text);
  $('chatText').value = '';
  renderChat();
});

$('chatReset').addEventListener('click', () => {
  if (chat.current && !chat.live) bridge.send({ type: 'chat_reset', model: chat.current });
});

bridge.addEventListener('status', () => {
  if (bridge.status !== 'online' && chat.live) {
    // La réponse continue côté VPS ; on la retrouvera dans l'historique à la reconnexion.
    pushChat(chat.live.model, 'error', 'connexion au VPS perdue : la réponse arrivera à la reconnexion');
    chat.live = null;
    renderChat();
  }
  chatControls();
});
renderChat();

// ---------- Divers ----------
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logEl.innerText);
    log('Journal copié.', 'ok');
  } catch (e) {
    log('Copie impossible : ' + e.message, 'err');
  }
});

paint(() => false);
render();
log(navigator.bluetooth ? 'Web Bluetooth disponible.' : 'Web Bluetooth absent : ouvre la page dans Bluefy.',
  navigator.bluetooth ? 'ok' : 'err');
