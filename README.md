# flipper-apps

Apps et scripts pour Flipper Zero.

## Cible

- Firmware officiel **1.5.1**, API **88.2** (relevé le 2026-11-04).
- Un `.fap` compilé pour une version d'API ne tourne que sur celle-ci : recompiler après chaque mise à jour du firmware.

## Structure

- `apps/<nom>/` : apps C (`.fap`), compilées avec [ufbt](https://github.com/flipperdevices/flipperzero-ufbt).
- `scripts/<nom>.js` : scripts JavaScript (mJS), sans compilation.

## Déploiement

- `.fap` : `/ext/apps/<catégorie>/` sur la carte SD.
- `.js` : `/ext/apps/Scripts/` sur la carte SD.
- Depuis le téléphone : app mobile Flipper, gestionnaire de fichiers, envoi par Bluetooth.
- Depuis le PC : qFlipper, ou `ufbt launch` en USB (fermer qFlipper avant).
