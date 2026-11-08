# Builder Flipper (.fap)

Compile des apps Flipper Zero (firmware officiel 1.5.1, API 88.2) écrites par des modèles, sans leur faire confiance.
`application.fam` est du Python exécuté par ufbt/SCons : tout build se fait donc dans un conteneur Docker jetable.

## Architecture

```
pont (flipper, 127.0.0.1:3040) --HTTP + X-Build-Token--> flipper-builder (root, 127.0.0.1:3050)
                                                              |
                                                              | docker run --rm -i (tar des sources sur stdin)
                                                              v
                                                   conteneur neuf « flipper-builder »
                                                   ufbt -> tar (build.log, app.fap, appid) sur stdout
```

- `Dockerfile` : image `flipper-builder`. ufbt 0.2.6 + SDK officiel 1.5.1 téléchargé à la construction,
  empreinte SHA-256 vérifiée (celle de `update.flipperzero.one/firmware/directory.json`), version d'API lue dans
  `api_symbols.csv` : la construction échoue si ce n'est pas 88.2. Un build d'essai télécharge la chaîne de
  compilation et prouve que le SDK compile. Les versions mesurées sont écrites dans `/etc/flipper-sdk.json`.
- `entrypoint.sh` : dans le conteneur, extrait les sources dans `/work/src`, lance `ufbt`, renvoie le résultat en tar.
  Le SDK reste en lecture seule dans `/opt/ufbt` ; l'état de ufbt (`build/`) va dans `/work/ufbt` (liens vers le SDK).
  `/tmp` de l'image pointe vers `/work/tmp` (SCons ne transmet pas `TMPDIR` à gcc).
- `server.js` + `lib.js` : service HTTP Node 24, sans dépendance.

## Sécurité

Chaque build lance un conteneur neuf avec :
`--network none --read-only --tmpfs /work (64 Mo) --user 10001 --cap-drop ALL --security-opt no-new-privileges
--pids-limit 256 --memory 1g (sans swap) --cpus 2 --log-driver none --rm`.

- Aucun volume ni dossier hôte monté, pas de socket Docker : les sources entrent en tar sur stdin, le .fap sort en tar sur stdout.
- 120 s maximum : le service fait `docker kill` puis `docker rm -f` (pas un simple timeout dans le conteneur).
  Au démarrage, le service supprime tout conteneur restant (étiquette `flipper-builder.job=1`).
- Le service tourne en root (il pilote Docker) mais n'écoute que sur 127.0.0.1. Son code est exécuté depuis
  `/opt/flipper-builder` (clone root:root, rien d'inscriptible par l'utilisateur flipper), jamais depuis `/opt/flipper-apps`.
- L'utilisateur flipper n'est pas dans le groupe docker : il ne parle qu'au service.
- Jeton `BUILD_TOKEN` (32 octets aléatoires) dans `/etc/flipper-builder.env` et `/etc/flipper-bridge.env` (root, 600),
  comparé à temps constant. Jamais affiché ni journalisé.
- Une sortie de conteneur trop grosse (plus de ~1,1 Mo) fait tuer le conteneur.

## API

`GET /health` -> `{"ok": true, "firmware": "1.5.1", "api": "88.2"}` (lu dans `/etc/flipper-sdk.json` de l'image).

`POST /build`, en-tête `X-Build-Token`, corps JSON :

```json
{"files": {"application.fam": "...", "app.c": "...", "images/x.png": {"base64": "..."}}}
```

Réponses :

| Cas | Code | Corps |
|---|---|---|
| build réussi | 200 | `{"ok": true, "appid": "...", "fap": "<base64>", "log": "..."}` |
| build raté, temps dépassé, .fap trop gros | 200 | `{"ok": false, "log": "..."}` |
| fichiers refusés (chemin, taille, nombre) | 400 | `{"ok": false, "log": "requête refusée : ..."}` |
| corps JSON de plus de 1 Mo | 413 | `{"ok": false, "log": "..."}` |
| jeton absent ou faux | 401 | `{"ok": false, "log": "jeton invalide"}` |
| un build déjà en cours | 429 | `{"ok": false, "log": "..."}` |

## Limites

- 50 fichiers, 512 Ko au total (après décodage base64), `application.fam` obligatoire à la racine.
- Chemins relatifs uniquement : segments `[A-Za-z0-9._-]`, ni `/` initial, ni `..`, ni `.`, 100 octets max.
- .fap de 1 Mo max, journal tronqué à 64 Ko (début et fin gardés).
- Un seul build à la fois, 120 s max.

## Déploiement (VPS)

- Clone root : `/opt/flipper-builder` (origin en https, root:root, 755).
- Image : `docker build -t flipper-builder /opt/flipper-builder/builder`.
- Unités dans `deploy/` : `flipper-builder.service` (dans `/etc/systemd/system/`),
  `flipper-builder-deploy.sh` (dans `/usr/local/bin/`), `flipper-builder-deploy.service` et `.timer`.
- **Mise à jour : à la main uniquement, quand Mikha le demande** (règle du 2026-11-08). Le builder tourne en root :
  un déploiement automatique depuis GitHub donnerait root sur le VPS à quiconque peut pousser sur `main`
  (compte GitHub, sessions Claude cloud, jeton qui fuiterait). `flipper-builder-deploy.timer` est donc
  **désactivé** (fichiers conservés, ne pas le réactiver).
- Procédure de mise à jour :
  1. `git -C /opt/flipper-builder fetch origin` puis montrer à Mikha
     `git -C /opt/flipper-builder diff HEAD origin/main -- builder/` (commit déployé contre origin/main).
  2. Attendre son accord explicite sur ce diff.
  3. Seulement ensuite : reconstruire l'image si `Dockerfile` ou `entrypoint.sh` ont changé,
     `git -C /opt/flipper-builder reset --hard origin/main`, puis `systemctl restart flipper-builder`
     et vérifier `curl -s 127.0.0.1:3050/health`.
- Le script de déploiement et les unités systemd ne sont pas mis à jour automatiquement : les réinstaller à la main.

## Tests

- Unitaires : `node --test builder/lib.test.js`.
- Bout en bout, sur le VPS en root, contre le service réel : `node builder/test-live.mjs`
  (jeton lu dans `/etc/flipper-builder.env`). Vérifie /health, 401, rejet de `../x` et d'un chemin absolu,
  build d'un hello world, échec d'un `application.fam` qui ouvre une connexion réseau, boucle infinie tuée à 120 s,
  429 pendant ce build, aucun conteneur restant.
