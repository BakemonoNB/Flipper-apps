# flipper-apps

Apps et scripts pour Flipper Zero.

## Cible

- Firmware officiel **1.5.1**, API **88.2** (relevé le 2026-11-04).
- Un `.fap` compilé pour une version d'API ne tourne que sur celle-ci : recompiler après chaque mise à jour du firmware.

## Structure

- `apps/<nom>/` : apps C (`.fap`), compilées avec [ufbt](https://github.com/flipperdevices/flipperzero-ufbt).
- `scripts/<nom>.js` : scripts JavaScript (mJS), sans compilation.
- `docs/` : pages web pour le téléphone, à ouvrir dans Bluefy (iOS) :
  - `docs/app/` : l'app (écran du Flipper en direct + boutons). `flipper.js` = client Bluetooth + RPC.
  - `docs/ble-test/` : test de connexion et ping RPC.
- `server/` : pont VPS ↔ téléphone (Node 24, sans dépendance). `node index.js` ; `node --test` pour les tests.
  - Variables : `PORT`, `HOST`, `PHONE_TOKEN` (app téléphone, WebSocket `/ws`), `API_TOKEN` (appelants de `/api/*` et `/logs`), `LOGS_TOKEN` (`/logs`).
  - API : `GET /api/status`, `POST /api/call {tool, args}` → relayé au téléphone, qui décide du niveau de l'outil et de la validation.
  - Chat : le téléphone envoie `{type:'chat', model, text}` sur `/ws` ; Claude (`claude -p`, seuls les outils Flipper via `mcp-flipper.js`) ou gpt-oss (Ollama, `num_ctx` 8192). Variables : `STATE_DIR`, `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`.
  - Outils des modèles : `tools.js` (descriptions) ; niveaux et validation : `docs/app/app.js` (`TOOLS`).

## Déploiement

- `.fap` : `/ext/apps/<catégorie>/` sur la carte SD.
- `.js` : `/ext/apps/Scripts/` sur la carte SD.
- Depuis le téléphone : app mobile Flipper, gestionnaire de fichiers, envoi par Bluetooth.
- Depuis le PC : qFlipper, ou `ufbt launch` en USB (fermer qFlipper avant).
