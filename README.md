# flipper-apps

Apps et scripts pour Flipper Zero.

## Cible

- Firmware officiel **1.5.1**, API **88.2** (relevé le 2026-11-04).
- Un `.fap` compilé pour une version d'API ne tourne que sur celle-ci : recompiler après chaque mise à jour du firmware.

## Structure

- `apps/<nom>/` : apps C (`.fap`), compilées avec [ufbt](https://github.com/flipperdevices/flipperzero-ufbt).
- `scripts/<nom>.js` : scripts JavaScript (mJS), sans compilation.
- `docs/` : pages web pour le téléphone, à ouvrir dans Bluefy (iOS) :
  - `docs/app/` : l'app. Onglets Manette, Chat, Apprendre (contenu dans `learn.js`), Réglages (dont le journal et les diagnostics). `flipper.js` = client Bluetooth + RPC, `bridge.js` = WebSocket vers le VPS, `policy.js` = règles de chemins.
  - `docs/ble-test/` : test de connexion et ping RPC.
- `server/` : pont VPS ↔ téléphone (Node 24, sans dépendance). `node index.js` ; `node --test` pour les tests.
  - Variables : `PORT`, `HOST`, `PHONE_TOKEN` (app téléphone, WebSocket `/ws`), `API_TOKEN` (appelants de `/api/*` et `/logs`), `LOGS_TOKEN` (`/logs`).
  - API : `GET /api/status`, `POST /api/call {tool, args}` → relayé au téléphone, qui décide du niveau de l'outil et de la validation.
  - Chat : le téléphone envoie `{type:'chat', model, text}` sur `/ws` ; Claude (`claude -p`, seuls les outils Flipper via `mcp-flipper.js`) ou gpt-oss (Ollama, `num_ctx` 8192). Variables : `STATE_DIR`, `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`.
  - Outils des modèles : `tools.js` (descriptions) ; niveaux et validation : `docs/app/app.js` (`TOOLS`) ; règles de chemins : `docs/app/policy.js`.
    Mémoire : `memory_search`, `memory_read` (notes flipper du brain, `BRAIN_DIR`), `memory_note` (brouillon dans `_drafts/inbox/`, relu par le curateur).
    `ping`, `get_screen` (image pour Claude, texte pour gpt-oss), `list_files`, `read_file` (lecture ; dossiers nfc/lfrfid/ibutton/subghz/u2f : validation), `write_file` et `delete_file` (validation, seulement `/ext/apps/Scripts/` et `/ext/apps_data/`), `press_button` et `start_app` (validation), `run_script` (validation avec le code affiché).
  - Catalogue officiel : `catalog_search` et `install_catalog_app` (`server/catalog.js`, catalog.flipperzero.one) téléchargent une app compatible (`FLIPPER_API`, `CATALOG_TARGET`) et l'installent via le téléphone (validation avec les infos du catalogue, pas de code source).
  - `server/workspace/` : dossier de travail de Claude (guide `CLAUDE.md` + types du SDK JS officiel, GPL-3.0).
  - Apps C : `build_app` et `install_app` s'exécutent sur le VPS (`server/builds.js`) : compilation par le service `builder/` (`BUILD_URL`, `BUILD_TOKEN`), puis installation par le téléphone (outil interne `install_fap`, validation avec le code source). Lancer un `.fap` avec `start_app` = niveau Exécution.

## Déploiement

- `.fap` : `/ext/apps/<catégorie>/` sur la carte SD.
- `.js` : `/ext/apps/Scripts/` sur la carte SD.
- Depuis le téléphone : app mobile Flipper, gestionnaire de fichiers, envoi par Bluetooth.
- Depuis le PC : qFlipper, ou `ufbt launch` en USB (fermer qFlipper avant).
