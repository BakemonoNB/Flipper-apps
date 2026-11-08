import { Flipper, Key, InputType, SCREEN_W, SCREEN_H, pixelOn, errText, MIN_CHUNK, encodePath, F } from './flipper.js';
import { BridgeClient } from './bridge.js';
import { MODULES } from './learn.js';
import { normPath, isSensitive, checkWritable, checkScript, parentOf, checkFapPath, isFap, MAX_READ_BYTES, MAX_WRITE_BYTES, MAX_FAP_BYTES } from './policy.js';

const $ = (id) => document.getElementById(id);
const flipper = new Flipper();
const bridge = new BridgeClient();

const DEFAULT_VPS_URL = 'wss://nova.astrae.tech/flipper/ws';
const SETTINGS_KEY = 'flipper-bridge';
const CHAT_MODEL_KEY = 'flipper-chat-model';
const TAB_KEY = 'flipper-tab';
const LONG_MS = 500;            // au-delà : appui long
const REPEAT_MS = 150;          // répétition des flèches pendant un appui long
const AUTO_STEP_MS = 15 * 60 * 1000;
const AUTO_MAX_MS = 2 * 60 * 60 * 1000;
const CONFIRM_MS = 110 * 1000;  // refus automatique (le serveur abandonne à 120 s)
const ON = [26, 16, 0];
const OFF = [255, 139, 26];

let battery = null;
let busy = null;
let serverCommit = null;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

// ---------- Annonces (VoiceOver) et journal ----------
function announce(msg) {
  const el = $('announce');
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 50);
}

const logEl = $('log');
function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = new Date().toLocaleTimeString('fr-FR') + '  ' + msg;
  logEl.appendChild(line);
  while (logEl.childElementCount > 300) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- Onglets ----------
const TABS = ['pad', 'chat', 'learn', 'settings'];
let currentTab = 'pad';

function selectTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'pad';
  currentTab = name;
  document.body.dataset.tab = name;
  for (const t of TABS) {
    const tab = $('tab-' + t);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $('panel-' + t).hidden = !on;
  }
  if (focus) $('tab-' + name).focus();
  if (name === 'chat') { chatUnread = 0; renderBadge(); requestAnimationFrame(() => scrollChat()); }
  else scroller.scrollTop = 0;
  store.set(TAB_KEY, name);
}

for (const t of TABS) $('tab-' + t).addEventListener('click', () => selectTab(t));
document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(currentTab);
  if (e.key === 'ArrowRight') { selectTab(TABS[(i + 1) % TABS.length], { focus: true }); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { selectTab(TABS[(i + TABS.length - 1) % TABS.length], { focus: true }); e.preventDefault(); }
});

// ---------- Écran ----------
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(SCREEN_W, SCREEN_H);
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
  lastFrame = { data: data.slice(0, SCREEN_W * SCREEN_H / 8), orientation, at: Date.now() };
  for (const r of frameWaiters.splice(0)) r();
}

let lastFrame = null;
const frameWaiters = [];
// Image actuelle de l'écran (attend la première si le flux vient de démarrer).
async function captureScreen() {
  if (!lastFrame) {
    await flipper.startScreen().catch(() => {});
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('aucune image reçue du Flipper')), 3000);
      frameWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  return lastFrame;
}

function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}


// ---------- État général ----------
const VPS_LABELS = {
  off: 'VPS non configuré',
  connecting: 'VPS : connexion…',
  online: 'VPS connecté',
  refused: 'VPS : jeton refusé',
  replaced: 'VPS : autre appareil',
  offline: 'VPS hors ligne',
};

function setChip(el, text, state) {
  el.className = 'chip' + (state ? ' ' + state : '');
  el.querySelector('.t').textContent = text;
}

function shortName() {
  return (flipper.name || 'Flipper').replace(/^Flipper\s+/, '');
}

function render() {
  const connected = flipper.connected;
  const main = $('main');
  main.textContent = connected ? 'Déconnecter' : flipper.device ? 'Reconnecter' : 'Connecter';
  main.className = 'btn ' + (connected ? '' : 'primary');
  main.disabled = !!busy;
  setChip($('status'), busy || (connected ? shortName() + (battery != null ? ' · ' + battery + ' %' : '') : 'Flipper hors ligne'),
    busy ? 'wait' : connected ? 'on' : '');
  const vs = bridge.status;
  setChip($('vpsStatus'), VPS_LABELS[vs], vs === 'online' ? 'on' : vs === 'refused' ? 'bad' : vs === 'connecting' ? 'wait' : '');
  $('deviceName').textContent = connected ? flipper.name : '';
  document.body.classList.toggle('connected', connected);
  $('other').disabled = connected;
  for (const b of document.querySelectorAll('[data-key]')) b.disabled = !connected;
  $('aboutServer').textContent = serverCommit ? 'commit ' + serverCommit : '—';
  chatControls();
}

async function withBusy(msg, fn) {
  busy = msg;
  render();
  try {
    await fn();
  } catch (e) {
    log('Échec : ' + (e && e.message ? e.message : e), 'err');
    announce('Échec de la connexion');
  } finally {
    busy = null;
    render();
  }
}

// ---------- Connexion au Flipper ----------
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator)) {
    log("Garde l'écran allumé : iOS coupe le Bluetooth quand le téléphone se verrouille.");
    return;
  }
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { log('Mise en veille non bloquée : ' + e.message); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (flipper.connected && !wakeLock) keepAwake();
  bridge.wake();
  if (wantConnected && !flipper.connected) autoReconnect();
});

// Reconnexion automatique : si le Flipper décroche sans que tu l'aies demandé (arrière-plan iOS, distance),
// l'app réessaie (1 s, 3 s, 8 s), et à nouveau quand tu reviens dans Bluefy.
let wantConnected = false;
let reconnecting = false;
async function autoReconnect() {
  if (reconnecting || !flipper.device) return;
  reconnecting = true;
  try {
    for (const delay of [1000, 3000, 8000]) {
      await new Promise((r) => setTimeout(r, delay));
      if (!wantConnected || flipper.connected || busy) return;
      if (document.visibilityState !== 'visible') return; // on reprendra au retour au premier plan
      try {
        busy = 'Reconnexion…';
        render();
        await connectFlow();
        log('Reconnecté automatiquement.', 'ok');
        return;
      } catch (e) {
        log('Reconnexion : ' + errText(e), 'err');
      } finally {
        busy = null;
        render();
      }
    }
    log('Reconnexion automatique abandonnée : touche Reconnecter.', 'err');
  } finally {
    reconnecting = false;
  }
}

const CHUNK_KEY = 'flipper-chunk';
async function connectFlow() {
  await flipper.connect();
  const saved = parseInt(store.get(CHUNK_KEY) || '', 10);
  flipper.chunk = Number.isInteger(saved) && saved >= MIN_CHUNK ? saved : MIN_CHUNK;
  battery = await flipper.battery();
  log('Connecté à ' + flipper.name + (battery != null ? ' (batterie ' + battery + ' %)' : ''), 'ok');
  log((flipper.flowFree !== null ? 'Contrôle de débit : ' + flipper.flowFree + ' octets libres' : 'Contrôle de débit indisponible') + ' · envois de ' + flipper.chunk + ' octets');
  announce('Flipper connecté');
  wantConnected = true;
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
  if (flipper.connected) { wantConnected = false; flipper.disconnect(); return; }
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
  lastFrame = null;
  log('Flipper déconnecté.', 'err');
  announce('Flipper déconnecté');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  render();
  sendState();
  if (wantConnected) autoReconnect();
});
flipper.addEventListener('error', (e) => log('Erreur de flux : ' + errText(e.detail), 'err'));
flipper.addEventListener('notice', (e) => log('Bluetooth : ' + e.detail, 'err'));
flipper.addEventListener('unsolicited', (e) => {
  const st = e.detail.fields.find((f) => f.field === 2);
  log('Message non attendu : id=' + e.detail.id + (st ? ' statut=' + st.value : '') + ' champs=' + e.detail.fields.map((f) => f.field).join(','), st ? 'err' : '');
});

// ---------- Manette ----------
const ARROWS = new Set([Key.UP, Key.DOWN, Key.LEFT, Key.RIGHT]);

function sendInput(key, type, label) {
  return flipper.input(key, type).catch((e) => log('Bouton ' + label + ' : ' + e.message, 'err'));
}

for (const btn of document.querySelectorAll('[data-key]')) {
  const key = Key[btn.dataset.key];
  let down = false, longSent = false, longTimer = null, repeatTimer = null;
  const send = (type) => sendInput(key, type, btn.dataset.key);

  const start = (e) => {
    if (e) e.preventDefault();
    if (!flipper.connected || down) return;
    down = true;
    longSent = false;
    if (e && e.pointerId !== undefined && btn.setPointerCapture) btn.setPointerCapture(e.pointerId);
    btn.classList.add('active');
    send(InputType.PRESS);
    longTimer = setTimeout(() => {
      longSent = true;
      send(InputType.LONG);
      if (ARROWS.has(key)) repeatTimer = setInterval(() => send(InputType.REPEAT), REPEAT_MS);
    }, LONG_MS);
  };
  const end = () => {
    if (!down) return;
    down = false;
    clearTimeout(longTimer);
    clearInterval(repeatTimer);
    btn.classList.remove('active');
    if (!longSent) send(InputType.SHORT);
    send(InputType.RELEASE);
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // VoiceOver et clavier déclenchent « click » sans pointerdown : appui court.
  btn.addEventListener('click', (e) => {
    if (e.detail !== 0 || !flipper.connected) return;
    send(InputType.PRESS); send(InputType.SHORT); send(InputType.RELEASE);
  });
}

const KEYBOARD = { ArrowUp: Key.UP, ArrowDown: Key.DOWN, ArrowLeft: Key.LEFT, ArrowRight: Key.RIGHT, Enter: Key.OK, Backspace: Key.BACK };
document.addEventListener('keydown', (e) => {
  if (currentTab !== 'pad' || !flipper.connected || e.repeat) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [role="tablist"], dialog')) return;
  if (e.key === 'Enter' && e.target.closest && e.target.closest('button')) return; // le bouton gère déjà Entrée
  if (!Object.hasOwn(KEYBOARD, e.key)) return;
  e.preventDefault();
  const k = KEYBOARD[e.key];
  sendInput(k, InputType.PRESS, e.key); sendInput(k, InputType.SHORT, e.key); sendInput(k, InputType.RELEASE, e.key);
});

// ---------- Mode autonome ----------
let autoUntil = 0;
let autoTick = null;
const autoActive = () => Date.now() < autoUntil;
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

function addAutonomy() {
  const now = Date.now();
  const before = autoUntil;
  autoUntil = Math.min((autoActive() ? autoUntil : now) + AUTO_STEP_MS, now + AUTO_MAX_MS);
  const added = Math.round((autoUntil - Math.max(before, now)) / 60000);
  log('Mode autonome : ' + (before > now ? '+' + added + ' min' : 'activé pour ' + added + ' min') + ' (fin à ' +
    new Date(autoUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ')', 'auto');
  announce('Mode autonome actif, ' + Math.round((autoUntil - now) / 60000) + ' minutes');
  clearInterval(autoTick);
  autoTick = setInterval(renderAuto, 1000);
  renderAuto();
}

function stopAutonomy(reason) {
  if (!autoUntil) return;
  autoUntil = 0;
  clearInterval(autoTick);
  autoTick = null;
  log('Mode autonome terminé (' + reason + ').', 'auto');
  announce('Mode autonome terminé');
  renderAuto();
}

const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>';
function renderAuto() {
  if (autoUntil && !autoActive()) { stopAutonomy('temps écoulé'); return; }
  const on = autoActive();
  const left = autoUntil - Date.now();
  const atMax = on && left > AUTO_MAX_MS - 60000;
  const more = $('autoMore');
  more.innerHTML = BOLT;
  const label = document.createElement('span');
  label.textContent = on ? mmss(left) + (atMax ? '' : ' · +15') : 'Auto';
  more.appendChild(label);
  more.classList.toggle('on', on);
  more.disabled = atMax;
  more.setAttribute('aria-label', on
    ? 'Mode autonome actif, il reste ' + Math.ceil(left / 60000) + ' minutes' + (atMax ? ', maximum atteint' : '. Ajouter 15 minutes')
    : 'Activer le mode autonome pendant 15 minutes');
  $('autoStop').hidden = !on;
  document.querySelector('.screen-card').classList.toggle('autonomous', on);
}

$('autoMore').addEventListener('click', addAutonomy);
$('autoStop').addEventListener('click', () => stopAutonomy('arrêté par toi'));

// ---------- Outils demandés par le VPS ----------
// Le niveau est décidé ICI, jamais par le message du serveur.
const LEVELS = { read: 'Lecture', sensitive: 'Lecture sensible', write: 'Écriture', action: 'Action', run: 'Exécution', emit: 'Émission' };
const RISKY = new Set(['run', 'emit']);
const JS_RUNNERS = ['/ext/apps/System/js_app.fap', 'JS Runner', 'js_app'];
let jsRunner = null;
const preview = (s, n = 4000) => (s.length > n ? s.slice(0, n) + '\n… (' + (s.length - n) + ' caractères de plus)' : s);
const KEY_NAMES = { up: ['Haut', Key.UP], down: ['Bas', Key.DOWN], left: ['Gauche', Key.LEFT], right: ['Droite', Key.RIGHT], ok: ['OK', Key.OK], back: ['Retour', Key.BACK] };
const ORIGINS = { claude: 'Claude', 'gpt-oss': 'gpt-oss', api: 'Le VPS' };

const TOOLS = {
  ping: {
    level: 'read',
    run: async () => ({ latencyMs: Math.round(await flipper.ping()) }),
  },
  press_button: {
    level: 'action',
    check: (a) => {
      if (!Object.hasOwn(KEY_NAMES, a.key)) throw new Error('bouton inconnu : ' + a.key);
      if (a.long !== undefined && typeof a.long !== 'boolean') throw new Error('« long » doit être vrai ou faux');
    },
    describe: (a) => 'appuyer sur ' + KEY_NAMES[a.key][0] + (a.long ? ' (appui long)' : ''),
    run: async (a) => {
      const k = KEY_NAMES[a.key][1];
      await flipper.input(k, InputType.PRESS);
      if (a.long) await new Promise((r) => setTimeout(r, LONG_MS));
      await flipper.input(k, a.long ? InputType.LONG : InputType.SHORT);
      await flipper.input(k, InputType.RELEASE);
      return { pressed: a.key, long: !!a.long };
    },
  },
  get_screen: {
    level: 'read',
    run: async () => {
      const f = await captureScreen();
      return { width: SCREEN_W, height: SCREEN_H, orientation: f.orientation, format: 'pages-8-lignes', data: toBase64(f.data) };
    },
  },
  list_files: {
    level: 'read',
    check: (a) => { a.path = normPath(a.path); },
    run: async (a) => {
      const all = await flipper.list(a.path);
      return { path: a.path, entries: all.slice(0, 300), truncated: all.length > 300 };
    },
  },
  read_file: {
    level: (a) => (isSensitive(a.path) ? 'sensitive' : 'read'),
    check: (a) => { a.path = normPath(a.path); },
    describe: (a) => 'lire ' + a.path,
    run: async (a) => {
      const st = await flipper.stat(a.path);
      if (!st) throw new Error('fichier introuvable');
      if (st.type !== 'file') throw new Error('c\'est un dossier : utilise list_files');
      if (st.size > MAX_READ_BYTES) throw new Error('fichier trop gros (' + st.size + ' octets, max ' + MAX_READ_BYTES + ')');
      const bytes = await flipper.read(a.path);
      try {
        return { path: a.path, size: bytes.length, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
      } catch {
        return { path: a.path, size: bytes.length, base64: toBase64(bytes) };
      }
    },
  },
  write_file: {
    level: 'write',
    check: (a) => {
      a.path = checkWritable(a.path);
      if (typeof a.content !== 'string') throw new Error('content doit être du texte');
      if (new TextEncoder().encode(a.content).length > MAX_WRITE_BYTES) throw new Error('contenu trop gros (max ' + MAX_WRITE_BYTES + ' octets)');
    },
    describe: (a) => 'écrire ' + a.path,
    preview: async (a) => preview(a.content),
    run: async (a) => {
      const bytes = new TextEncoder().encode(a.content);
      await flipper.mkdirs(parentOf(a.path));
      await flipper.write(a.path, bytes);
      return { path: a.path, size: bytes.length };
    },
  },
  delete_file: {
    level: 'write',
    check: (a) => { a.path = checkWritable(a.path); },
    describe: (a) => 'supprimer ' + a.path,
    run: async (a) => { await flipper.delete(a.path, false); return { deleted: a.path }; },
  },
  run_script: {
    level: 'run',
    check: (a) => { a.path = checkScript(a.path); },
    describe: (a) => 'lancer le script ' + a.path.split('/').pop(),
    preview: async (a) => {
      try { return preview(new TextDecoder().decode(await flipper.read(a.path))); }
      catch (e) { return '(contenu illisible : ' + e.message + ')'; }
    },
    run: async (a) => {
      const tried = [];
      for (const name of jsRunner ? [jsRunner] : JS_RUNNERS) {
        try {
          await flipper.startApp(name, a.path);
          jsRunner = name;
          return { started: a.path, runner: name, hint: 'regarde l\'écran avec get_screen ; appui long sur back pour quitter' };
        } catch (e) { tried.push(name + ' → ' + e.message); }
      }
      jsRunner = null;
      throw new Error('impossible de lancer le script. Essais : ' + tried.join(' | '));
    },
  },
  install_fap: {
    // Appelé seulement par le serveur (install_app), avec un .fap sorti du builder.
    level: 'write',
    check: (a) => {
      a.path = checkFapPath(a.path);
      if (typeof a.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64)) throw new Error('contenu de l\'app invalide');
      if (a.base64.length * 3 / 4 > MAX_FAP_BYTES) throw new Error('app trop grosse (1 Mo max)');
    },
    describe: (a) => 'installer l\'app ' + a.path.split('/').pop() + ' (' + Math.ceil((a.base64.length * 3 / 4) / 1024) + ' Ko)',
    preview: async (a) => (typeof a.source === 'string' ? preview(a.source, 8000) : '(code source non fourni)'),
    run: async (a) => {
      const bin = atob(a.base64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      try { await flipper.mkdirs(parentOf(a.path)); }
      catch (e) { throw new Error('création du dossier ' + parentOf(a.path) + ' : ' + errText(e)); }
      const t0 = performance.now();
      try { await flipper.write(a.path, bytes); }
      catch (e) { throw new Error('écriture de ' + bytes.length + ' octets : ' + errText(e)); }
      log('App écrite : ' + bytes.length + ' octets en ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
      return { path: a.path, size: bytes.length, next: 'start_app avec name = ' + a.path };
    },
  },
  start_app: {
    // Lancer un .fap = exécuter du code (souvent écrit par un modèle) : niveau Exécution.
    level: (a) => (isFap(a.name) ? 'run' : 'action'),
    check: (a) => {
      if (typeof a.name !== 'string' || !a.name || a.name.length > 128) throw new Error('nom d\'app invalide');
      if (a.args !== undefined && (typeof a.args !== 'string' || a.args.length > 255)) throw new Error('args invalides');
      if (isFap(a.name)) a.name = normPath(a.name);
    },
    describe: (a) => (isFap(a.name) ? 'lancer l\'app ' + a.name.split('/').pop() : 'ouvrir l\'app ' + a.name) + (a.args ? ' avec ' + a.args : ''),
    run: async (a) => { await flipper.startApp(a.name, a.args || ''); return { started: a.name }; },
  },
};

// File de validations : une fenêtre à la fois.
const dlg = $('confirm');
const confirmQueue = [];
let confirmCurrent = null;
let confirmTimer = null;

function confirmAction(req) {
  return new Promise((resolve) => {
    confirmQueue.push({ ...req, resolve });
    pumpConfirm();
  });
}

function pumpConfirm() {
  if (confirmCurrent || !confirmQueue.length) return;
  const c = confirmQueue.shift();
  if (autoActive()) { c.resolve('allow'); pumpConfirm(); return; } // autonomie activée pendant l'attente
  confirmCurrent = c;
  const risky = RISKY.has(c.level);
  $('cLevel').textContent = LEVELS[c.level] || c.level;
  $('cLevel').className = 'eyebrow' + (risky ? ' emit' : '');
  $('cTitle').textContent = (ORIGINS[c.origin] || c.origin) + ' veut ' + c.summary;
  $('cDesc').textContent = {
    run: c.tool === 'start_app'
      ? 'Une app compilée a accès à tout le Flipper (radio, USB, GPIO, fichiers). Ne la lance que si tu as validé son code.'
      : 'Un script peut taper au clavier d\'un ordinateur branché en USB (Bad USB) ou piloter les broches GPIO. Lis le code.',
    emit: 'Émission radio, infrarouge ou NFC : vérifie que c\'est légal et voulu.',
    sensitive: 'Ce dossier peut contenir des copies de badges, de cartes ou de clés.',
    write: c.tool === 'install_fap' ? 'Code source de l\'app ci-dessous. Installer ne la lance pas.' : 'Le fichier sera créé ou remplacé sur la carte SD.',
  }[c.level] || 'Regarde l\'écran du Flipper si besoin.';
  const args = { ...c.args };
  if (typeof args.content === 'string') args.content = '(' + args.content.length + ' caractères, voir ci-dessous)';
  if (typeof args.base64 === 'string') args.base64 = '(' + Math.round(args.base64.length * 3 / 4) + ' octets)';
  if (typeof args.source === 'string') args.source = '(voir ci-dessous)';
  $('cDetail').textContent = c.tool + ' ' + JSON.stringify(args);
  $('cPreview').hidden = !c.preview;
  $('cPreview').textContent = c.preview || '';
  $('cPreview').scrollTop = 0;
  const end = Date.now() + CONFIRM_MS;
  const tick = () => {
    const left = end - Date.now();
    $('cCount').textContent = 'Refus automatique dans ' + Math.ceil(left / 1000) + ' s';
    if (left <= 0) dlg.close('deny');
  };
  tick();
  confirmTimer = setInterval(tick, 1000);
  dlg.returnValue = '';
  dlg.showModal();
  if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
}

dlg.addEventListener('close', () => {
  if (!confirmCurrent) return;
  clearInterval(confirmTimer);
  const c = confirmCurrent;
  confirmCurrent = null;
  c.resolve(['allow', 'auto'].includes(dlg.returnValue) ? dlg.returnValue : 'deny');
  pumpConfirm();
});

function cancelAllConfirms() {
  while (confirmQueue.length) confirmQueue.shift().resolve('deny');
  if (confirmCurrent) dlg.close('deny');
}

async function handleCall({ id, tool, args, origin }) {
  const t = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : null;
  const who = ORIGINS[origin] || origin;
  const fail = (msg) => { log(who + ' → ' + tool + ' : ' + msg, 'err'); bridge.reply(id, false, msg); };
  if (!t) return fail('outil inconnu sur le téléphone');
  const a = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  try { if (t.check) t.check(a); } catch (e) { return fail(e.message); }
  if (!flipper.connected) return fail('Flipper non connecté au téléphone');
  const level = typeof t.level === 'function' ? t.level(a) : t.level;
  let how = '';
  if (level !== 'read') {
    if (autoActive()) {
      how = ' (autonome)';
    } else {
      const pv = t.preview ? await t.preview(a) : null;
      const decision = await confirmAction({ tool, args: a, origin, level, preview: pv, summary: t.describe ? t.describe(a) : tool });
      if (decision === 'deny') return fail('refusé par Mikha');
      if (decision === 'auto') addAutonomy();
      how = ' (validé)';
    }
  }
  try {
    const result = await t.run(a);
    log(who + ' → ' + tool + (a.path ? ' ' + a.path : '') + how + ' : OK', level === 'read' ? 'ok' : 'auto');
    bridge.reply(id, true, result);
  } catch (e) {
    fail(errText(e));
  }
}

// ---------- Pont VPS ----------
function sendState() {
  bridge.send({
    type: 'state',
    state: { flipper: { connected: flipper.connected, name: flipper.name, battery: flipper.connected ? battery : null } },
  });
}

function loadSettings() {
  try {
    const s = JSON.parse(store.get(SETTINGS_KEY) || '{}');
    return { url: typeof s.url === 'string' && s.url ? s.url : DEFAULT_VPS_URL, token: typeof s.token === 'string' ? s.token : '' };
  } catch {
    return { url: DEFAULT_VPS_URL, token: '' };
  }
}

bridge.addEventListener('status', (e) => {
  const st = e.detail;
  if (st === 'online') { log('VPS connecté.', 'ok'); sendState(); }
  else if (st === 'refused') log('VPS : jeton refusé. Vérifie-le dans Réglages.', 'err');
  else if (st === 'replaced') log('VPS : un autre appareil s\'est connecté avec ce jeton.', 'err');
  if (st !== 'online') {
    cancelAllConfirms();
    if (chat.live) {
      pushChat(chat.live.model, 'error', 'connexion au VPS perdue : la réponse arrivera à la reconnexion');
      chat.live = null;
      renderChat();
    }
  }
  render();
});
bridge.addEventListener('call', (e) => { handleCall(e.detail); });

$('vpsSave').addEventListener('click', () => {
  const url = $('vpsUrl').value.trim() || DEFAULT_VPS_URL;
  const token = $('vpsToken').value.trim();
  if (!/^wss:\/\//.test(url)) { log('L\'adresse du VPS doit commencer par wss://', 'err'); announce('Adresse invalide'); return; }
  if (!store.set(SETTINGS_KEY, JSON.stringify({ url, token }))) log('Réglages non mémorisés (stockage indisponible).', 'err');
  bridge.configure(url, token);
  log(token ? 'Réglages VPS enregistrés.' : 'Jeton vide : pont VPS désactivé.');
  announce(token ? 'Réglages enregistrés' : 'Pont VPS désactivé');
});

$('vpsShow').addEventListener('click', () => {
  const input = $('vpsToken');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('vpsShow').textContent = show ? 'Cacher' : 'Voir';
  $('vpsShow').setAttribute('aria-pressed', String(show));
});

// ---------- Chat ----------
const chat = { models: [], histories: {}, current: null, live: null };
let chatUnread = 0;

function renderBadge() {
  const b = $('chatBadge');
  b.hidden = !chatUnread;
  b.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
}

function chatControls() {
  const online = bridge.status === 'online';
  $('chatSend').disabled = !online || !!chat.live || !chat.current;
  $('chatReset').disabled = !online || !!chat.live || !chat.current;
  for (const r of document.querySelectorAll('#chatModels input')) r.disabled = !!chat.live;
  $('chatText').placeholder = online ? 'Demande au modèle…' : 'VPS non connecté';
}

// ---------- Défilement ----------
// La coque est fixe : seul #scroller défile. On ne ramène en bas que si on y était déjà.
const scroller = $('scroller');
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
function scrollChat() {
  scroller.scrollTop = scroller.scrollHeight;
  $('toBottom').hidden = true;
}
function followChat(wasNear) {
  if (currentTab !== 'chat') return;
  if (wasNear) scrollChat();
  else $('toBottom').hidden = false;
}
scroller.addEventListener('scroll', () => { if (nearBottom()) $('toBottom').hidden = true; }, { passive: true });
$('toBottom').addEventListener('click', scrollChat);

// Hauteur de la coque = partie réellement visible (le clavier iOS ne recouvre plus la saisie).
{
  const vv = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty('--app-h', Math.round(vv ? vv.height : innerHeight) + 'px');
    if (window.scrollY) window.scrollTo(0, 0);
  };
  fit();
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
  addEventListener('resize', fit);
}

// Markdown minimal et sûr (aucun HTML du modèle n'est interprété) : gras, `code`, blocs de code, listes, titres.
function mdInline(parent, text) {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    const el = document.createElement(tok[0] === '`' ? 'code' : 'strong');
    el.textContent = tok[0] === '`' ? tok.slice(1, -1) : tok.slice(2, -2);
    parent.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(el, text) {
  const parts = text.split(/```[^\n]*\n?([\s\S]*?)```/g); // indices impairs : blocs de code
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/\n$/, '');
      pre.append(code);
      el.append(pre);
      return;
    }
    let para = null;
    let list = null;
    for (const line of part.split('\n')) {
      if (!line.trim()) { para = null; list = null; continue; }
      const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
      const h = /^#{1,4}\s+(.*)$/.exec(line);
      if (li) {
        const tag = li[1] ? 'OL' : 'UL';
        if (!list || list.tagName !== tag) { list = document.createElement(tag); el.append(list); para = null; }
        const item = document.createElement('li');
        mdInline(item, li[2]);
        list.append(item);
        continue;
      }
      list = null;
      if (h) {
        const p = document.createElement('p');
        const s = document.createElement('strong');
        mdInline(s, h[1]);
        p.append(s);
        el.append(p);
        para = null;
        continue;
      }
      if (!para) { para = document.createElement('p'); el.append(para); } else para.append(document.createElement('br'));
      mdInline(para, line);
    }
  });
}

const SUGGESTIONS = [
  'Que montre l\'écran du Flipper ?',
  'Écris un script qui fait clignoter la LED',
  'Ouvre le menu Sub-GHz et décris-le',
  'Qu\'as-tu appris sur ce Flipper ?',
];
const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>';
const openActs = new Set(); // groupes d'actions dépliés (survivent au rafraîchissement)

function renderChat() {
  const box = $('chatLog');
  box.textContent = '';
  const items = chat.histories[chat.current] || [];
  const live = chat.live && chat.live.model === chat.current;
  if (!items.length && !live) {
    const p = document.createElement('p');
    p.className = 'chat-empty';
    p.textContent = chat.models.length
      ? 'Demande quelque chose au modèle : il voit l\'écran, appuie sur les boutons, écrit des scripts et des apps.'
      : 'Connecte le VPS (Réglages) pour discuter avec les modèles.';
    box.appendChild(p);
    if (chat.models.length) {
      const wrap = document.createElement('div');
      wrap.className = 'suggest';
      for (const s of SUGGESTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = s;
        b.addEventListener('click', () => { $('chatText').value = s; autoGrow(); $('chatText').focus(); });
        wrap.appendChild(b);
      }
      box.appendChild(wrap);
    }
  }
  // Les appels d'outils consécutifs sont regroupés en une ligne repliable.
  let acts = [];
  let actsKey = 0;
  const flushActs = () => {
    if (!acts.length) return;
    const key = chat.current + ':' + actsKey;
    const d = document.createElement('details');
    d.className = 'acts';
    d.open = openActs.has(key);
    d.addEventListener('toggle', () => (d.open ? openActs.add(key) : openActs.delete(key)));
    const counts = {};
    for (const a of acts) { const n = a.split(' ')[0]; counts[n] = (counts[n] || 0) + 1; }
    const s = document.createElement('summary');
    s.innerHTML = GEAR;
    s.append(acts.length + (acts.length > 1 ? ' actions · ' : ' action · ') +
      Object.entries(counts).map(([n, c]) => n + (c > 1 ? ' ×' + c : '')).join(' · '));
    const ul = document.createElement('ul');
    for (const a of acts) { const li = document.createElement('li'); li.textContent = a; ul.appendChild(li); }
    d.append(s, ul);
    box.appendChild(d);
    acts = [];
  };
  items.forEach((it, i) => {
    if (it.role === 'tool') { if (!acts.length) actsKey = i; acts.push(it.text); return; }
    flushActs();
    const d = document.createElement('div');
    const role = ['user', 'assistant', 'error'].includes(it.role) ? it.role : 'assistant';
    d.className = 'msg ' + role;
    if (role === 'assistant') renderMarkdown(d, it.text); else d.textContent = it.text;
    box.appendChild(d);
  });
  flushActs();
  if (live && (!items.length || items[items.length - 1].role !== 'assistant')) {
    const w = document.createElement('div');
    w.className = 'typing';
    w.setAttribute('role', 'img');
    w.setAttribute('aria-label', 'Le modèle réfléchit');
    w.innerHTML = '<i></i><i></i><i></i>';
    box.appendChild(w);
  }
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
  const box = $('chatModels');
  box.textContent = '';
  const saved = store.get(CHAT_MODEL_KEY);
  chat.current = chat.models.some((m) => m.id === saved) ? saved : (chat.models[0] ? chat.models[0].id : null);
  for (const m of chat.models) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'chatModel';
    input.value = m.id;
    input.checked = m.id === chat.current;
    input.addEventListener('change', () => {
      chat.current = m.id;
      store.set(CHAT_MODEL_KEY, m.id);
      renderChat();
    });
    const span = document.createElement('span');
    span.textContent = m.label;
    label.append(input, span);
    box.appendChild(label);
  }
  renderChat();
}

bridge.addEventListener('message', (e) => {
  const m = e.detail;
  if (m.type === 'welcome') {
    serverCommit = m.commit || null;
    setModels(m.models);
    render();
  } else if (m.type === 'chat_history') {
    if (chat.live && chat.live.model === m.model) return; // réponse en cours : on garde l'affichage local
    chat.histories[m.model] = (m.items || []).map((it) => ({ role: it.role, text: it.text }));
    if (m.model === chat.current) { renderChat(); if (currentTab === 'chat') scrollChat(); }
  } else if (m.type === 'chat_event') {
    const wasNear = nearBottom();
    if (m.event === 'text') {
      pushChat(m.model, 'assistant', m.text || '');
      // Pendant l'écriture, on ne redessine que la dernière bulle (pas toute la conversation).
      const h = chat.histories[m.model];
      const last = h[h.length - 1];
      const bubble = m.model === chat.current ? $('chatLog').lastElementChild : null;
      if (bubble && bubble.classList.contains('msg') && bubble.classList.contains('assistant') && last.live) {
        bubble.textContent = '';
        renderMarkdown(bubble, last.text);
        followChat(wasNear);
        return;
      }
    } else if (m.event === 'tool') {
      pushChat(m.model, 'tool', m.tool + ' ' + JSON.stringify(m.args || {}));
      log((ORIGINS[m.model] || m.model) + ' utilise ' + m.tool);
    } else if (m.event === 'error') {
      pushChat(m.model, 'error', m.error || 'erreur');
    }
    if (m.event === 'done' || m.event === 'error') {
      if (chat.live && chat.live.id === m.id) chat.live = null;
      for (const it of chat.histories[m.model] || []) it.live = false;
      announce(m.event === 'done' ? 'Réponse de ' + (ORIGINS[m.model] || m.model) + ' reçue' : 'Erreur du modèle');
      if (currentTab !== 'chat') { chatUnread++; renderBadge(); }
    }
    if (m.model === chat.current) { renderChat(); followChat(wasNear); }
    else chatControls();
  }
});

function sendChat() {
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
  autoGrow();
  renderChat();
  scrollChat();
}

function autoGrow() {
  const t = $('chatText');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

$('chatSend').addEventListener('click', sendChat);
$('chatText').addEventListener('input', autoGrow);
$('chatText').addEventListener('keydown', (e) => {
  // Entrée envoie sur un clavier physique ; sur iPhone, le bouton envoie et Entrée fait un retour à la ligne.
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendChat(); }
});
$('chatReset').addEventListener('click', () => {
  if (chat.current && !chat.live && confirm('Effacer la conversation avec ' + (ORIGINS[chat.current] || chat.current) + ' ?')) {
    bridge.send({ type: 'chat_reset', model: chat.current });
  }
});

// ---------- Test de l'envoi Bluetooth ----------
$('probe').addEventListener('click', async () => {
  if (!flipper.connected) { log('Test Bluetooth : connecte d\'abord le Flipper.', 'err'); return; }
  $('probe').disabled = true;
  log('Test Bluetooth : envois de taille croissante…');
  try {
    const best = await flipper.probeChunk((size, ok, why) => log('  ' + size + ' octets : ' + (ok ? 'OK' : 'refusé (' + why + ')'), ok ? 'ok' : 'err'));
    if (best >= MIN_CHUNK) {
      store.set(CHUNK_KEY, String(best));
      flipper.chunk = best;
      log('Test Bluetooth : les transferts utiliseront ' + best + ' octets par envoi.', 'ok');
    } else {
      log('Test Bluetooth : même 20 octets sont refusés.', 'err');
    }
    if (best < 240) log('Après un refus, déconnecte puis reconnecte le Flipper avant de continuer.', 'err');
  } finally {
    $('probe').disabled = false;
    showJournal();
  }
});

// ---------- Diagnostic d'écriture ----------
// Essaie séparément chaque différence entre un ping (qui passe) et l'installation d'une app (refusée).
$('diag').addEventListener('click', async () => {
  if (!flipper.connected) { log('Diagnostic : connecte d\'abord le Flipper.', 'err'); return; }
  $('diag').disabled = true;
  showJournal();
  const dir = '/ext/apps_data/flipper_bridge';
  const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => 32 + (i % 90));
  const step = async (label, fn) => {
    try { const r = await fn(); log('  OK    ' + label + (r !== undefined ? ' (' + r + ')' : ''), 'ok'); return true; }
    catch (e) { log('  ÉCHEC ' + label + ' : ' + errText(e), 'err'); return false; }
  };
  const savedChunk = flipper.chunk;
  log('Diagnostic d\'écriture (écriture sans accusé ' + (flipper.rx.writeValueWithoutResponse ? 'disponible' : 'ABSENTE') + ', envois de ' + flipper.chunk + ' octets) :');
  try {
    await step('ping 20 octets', () => flipper.rawPing(20).then((ms) => ms + ' ms'));
    await step('ping 240 octets', () => flipper.rawPing(240).then((ms) => ms + ' ms'));
    await step('lecture de la place libre puis ping 240', () => flipper.rawPing(240, { readFirst: true }).then((ms) => ms + ' ms'));
    await step('mkdir d\'un dossier existant (/ext/apps)', () => flipper.request(F.storageMkdir, encodePath('/ext/apps'))
      .then(() => 'créé', (e) => { if (e.status === 6) return 'existe déjà, normal'; throw e; }));
    await step('ping 240 juste après', () => flipper.rawPing(240).then((ms) => ms + ' ms'));
    await step('création de ' + dir, () => flipper.mkdirs(dir));
    await step('écriture 100 octets (1 message)', () => flipper.write(dir + '/test1.txt', bytes(100)));
    await step('écriture 1500 octets (3 messages)', () => flipper.write(dir + '/test2.txt', bytes(1500)));
    await step('relecture des 1500 octets', async () => {
      const back = await flipper.read(dir + '/test2.txt');
      const want = bytes(1500);
      if (back.length !== 1500 || !back.every((v, i) => v === want[i])) throw new Error('contenu différent (' + back.length + ' octets)');
      return 'identique';
    });
    if (flipper.rx && flipper.rx.writeValueWithoutResponse) {
      flipper.noResponse = true;
      await step('SANS ACCUSÉ : ping 240', () => flipper.rawPing(240).then((ms) => ms + ' ms'));
      await step('SANS ACCUSÉ : écriture 1500 octets', () => flipper.write(dir + '/test3.txt', bytes(1500)));
    }
  } finally {
    flipper.noResponse = false;
    flipper.chunk = savedChunk;
    $('diag').disabled = false;
  }
  log('Diagnostic terminé : Copier, puis envoie le journal. Si une étape a échoué, reconnecte le Flipper ensuite.');
});

function showJournal() {
  selectTab('settings');
  requestAnimationFrame(() => $('journalCard').scrollIntoView({ block: 'start' }));
}

// ---------- Apprendre ----------
const LEARN_KEY = 'flipper-learn-done';
const learnDone = new Set((() => { try { return JSON.parse(store.get(LEARN_KEY) || '[]'); } catch { return []; } })());
let learnCurrent = null;

function renderLearn() {
  const box = $('learnCards');
  box.textContent = '';
  for (const m of MODULES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'learn-card' + (learnDone.has(m.id) ? ' done' : '');
    b.setAttribute('aria-label', m.title + (learnDone.has(m.id) ? ', terminé' : '') + '. ' + m.pitch);
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = m.icon; ic.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    const t = document.createElement('div'); t.className = 't'; t.textContent = m.title;
    const p = document.createElement('div'); p.className = 'p'; p.textContent = m.pitch;
    txt.append(t, p);
    const ck = document.createElement('span'); ck.className = 'ck'; ck.textContent = '✓'; ck.setAttribute('aria-hidden', 'true');
    b.append(ic, txt, ck);
    b.addEventListener('click', () => openModule(m.id));
    box.appendChild(b);
  }
  $('learnProgress').textContent = learnDone.size + ' / ' + MODULES.length + ' terminés';
}

function openModule(id) {
  const m = MODULES.find((x) => x.id === id);
  if (!m) return;
  learnCurrent = m;
  $('ldTitle').textContent = m.title;
  $('ldWhat').textContent = m.what;
  const ol = $('ldSteps');
  ol.textContent = '';
  for (const s of m.steps) { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); }
  $('ldLegal').hidden = !m.legal;
  $('ldLegal').textContent = m.legal || '';
  $('ldOpen').hidden = !m.app;
  $('ldOpen').textContent = 'Ouvrir sur le Flipper';
  renderDone();
  $('learnList').hidden = true;
  $('learnDetail').hidden = false;
  scroller.scrollTop = 0;
  $('ldTitle').setAttribute('tabindex', '-1');
  $('ldTitle').focus({ preventScroll: true });
}

function renderDone() {
  const done = learnCurrent && learnDone.has(learnCurrent.id);
  $('ldDone').textContent = done ? '✓ Terminé' : 'Marquer comme fait';
  $('ldDone').setAttribute('aria-pressed', String(!!done));
}

$('learnBack').addEventListener('click', () => {
  $('learnDetail').hidden = true;
  $('learnList').hidden = false;
  renderLearn();
  scroller.scrollTop = 0;
});

$('ldDone').addEventListener('click', () => {
  if (!learnCurrent) return;
  if (learnDone.has(learnCurrent.id)) learnDone.delete(learnCurrent.id); else learnDone.add(learnCurrent.id);
  store.set(LEARN_KEY, JSON.stringify([...learnDone]));
  renderDone();
  announce(learnDone.has(learnCurrent.id) ? 'Module terminé' : 'Module à refaire');
});

$('ldOpen').addEventListener('click', async () => {
  const m = learnCurrent;
  if (!m || !m.app) return;
  if (!flipper.connected) { announce('Connecte d\'abord le Flipper'); $('ldOpen').textContent = 'Connecte d\'abord le Flipper'; return; }
  $('ldOpen').disabled = true;
  try {
    await flipper.startApp(m.app);
    $('ldOpen').textContent = 'Ouvert sur le Flipper ✓';
    log('Apprendre : ' + m.app + ' ouvert.', 'ok');
  } catch (e) {
    $('ldOpen').textContent = 'Ouverture impossible : ouvre-le depuis le menu';
    log('Apprendre : ouverture de « ' + m.app + ' » impossible : ' + errText(e), 'err');
  } finally {
    $('ldOpen').disabled = false;
  }
});

$('ldCoach').addEventListener('click', () => {
  const m = learnCurrent;
  if (!m) return;
  selectTab('chat');
  const claude = document.querySelector('#chatModels input[value="claude"]');
  if (claude && !chat.live) { claude.checked = true; claude.dispatchEvent(new Event('change')); }
  $('chatText').value = 'Mode coach, module « ' + m.title + ' ». Guide-moi pas à pas pour ' + m.coach + '. '
    + 'À chaque étape : regarde l\'écran avec get_screen, dis-moi exactement quel bouton presser, puis vérifie que j\'ai réussi avant la suite. '
    + 'N\'appuie jamais toi-même et ne lance rien : c\'est moi qui fais. Commence par me dire où je dois être.';
  autoGrow();
  $('chatText').focus();
});

// ---------- Mise à jour de l'app ----------
// GitHub Pages met les fichiers en cache 10 min : on les redemande au réseau, puis on recharge.
const APP_FILES = ['./', './index.html', './app.js', './flipper.js', './bridge.js', './policy.js', './learn.js'];
$('updateApp').addEventListener('click', async () => {
  $('updateApp').disabled = true;
  $('updateApp').textContent = 'Mise à jour…';
  try {
    await Promise.all(APP_FILES.map((f) => fetch(f, { cache: 'reload' })));
  } catch (e) {
    log('Mise à jour : ' + e.message, 'err');
  }
  location.reload();
});

// ---------- Journal ----------
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logEl.innerText);
    log('Journal copié.', 'ok');
    announce('Journal copié');
  } catch (e) {
    log('Copie impossible : ' + e.message, 'err');
  }
});
$('clearLog').addEventListener('click', () => { logEl.textContent = ''; announce('Journal effacé'); });

// ---------- Démarrage ----------
paint(() => false);
selectTab(store.get(TAB_KEY) || 'pad');
renderAuto();
{
  const s = loadSettings();
  $('vpsUrl').value = s.url;
  $('vpsToken').value = s.token;
  bridge.configure(s.url, s.token);
}
renderChat();
renderLearn();
render();
log(navigator.bluetooth ? 'Web Bluetooth disponible.' : 'Web Bluetooth absent : ouvre la page dans Bluefy.',
  navigator.bluetooth ? 'ok' : 'err');

// Accès de test (?debug) : permet de simuler un Flipper dans un navigateur sans Bluetooth.
if (new URLSearchParams(location.search).has('debug')) window.__flipperApp = { flipper, bridge, render };
