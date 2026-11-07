import { Flipper, Key, InputType, SCREEN_W, SCREEN_H, pixelOn } from './flipper.js';

const $ = (id) => document.getElementById(id);
const flipper = new Flipper();
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
    : 'Déconnecté');
  status.className = 'status' + (connected ? ' on' : '');
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
