# flipper-apps

- Cible : firmware officiel 1.5.1, API 88.2. Ne pas utiliser de symbole hors de l'API publique de cette version.
- Apps C dans `apps/<nom>/` (un `application.fam` par app), build avec `ufbt` depuis le dossier de l'app.
- Scripts JS (mJS) dans `scripts/`.
- L'utilisateur travaille souvent depuis son téléphone : le déploiement passe par l'app mobile Flipper (Bluetooth), sans CLI ni USB. Tout ce qui dépend de l'USB (Bad USB, HID USB) se teste sur le PC Windows.
- Le conteneur cloud ne joint pas `update.flipperzero.one` par défaut : sans ce domaine autorisé, ufbt ne peut pas télécharger le SDK.
