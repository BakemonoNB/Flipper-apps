# flipper-apps

- Firmware du Flipper : Unleashed unlshd-094 (API 88.19) depuis le 2026-11-08 (avant : officiel 1.5.1, API 88.2). Compatible avec le catalogue et le SDK officiels (API 88.x) ; Momentum écarté (API 87.1). Le firmware réel est lu par l'app à chaque connexion (`system_device_info`) et envoyé au serveur : SDK du builder, API du catalogue et prompts en dépendent. Ne pas utiliser de symbole hors de l'API publique du firmware visé.
- Apps C dans `apps/<nom>/` (un `application.fam` par app), build avec `ufbt` depuis le dossier de l'app.
- Scripts JS (mJS) dans `scripts/`.
- L'utilisateur travaille souvent depuis son téléphone : le déploiement passe par l'app mobile Flipper (Bluetooth), sans CLI ni USB. Tout ce qui dépend de l'USB (Bad USB, HID USB) se teste sur le PC Windows.
- Le conteneur cloud ne joint pas `update.flipperzero.one` par défaut : sans ce domaine autorisé, ufbt ne peut pas télécharger le SDK.
- Pont VPS : code dans `server/` (écrit ici), déployé par l'agent du VPS (infra seulement : systemd, Caddy, timer de déploiement). `/health` public, `/logs` protégé par `LOGS_TOKEN` (jamais dans le chat : passer par le formulaire de secret de l'environnement cloud).
- Avant de demander une info sur le VPS à l'utilisateur, chercher dans le brain (`bakemononb/brain`, `_Claude/`).
