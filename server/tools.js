// Outils proposés aux modèles (description + schéma des arguments).
// Le téléphone garde sa propre liste, ses niveaux et ses règles de chemins :
// un outil décrit ici mais inconnu ou refusé par le téléphone ne s'exécute pas.
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const path = (description) => ({ type: 'string', description });

export const TOOLS = [
  {
    name: 'ping',
    description: 'Vérifie que le Flipper Zero répond (aller-retour Bluetooth). Renvoie la latence en ms.',
    inputSchema: obj({}),
  },
  {
    name: 'get_screen',
    description: 'Capture l\'écran actuel du Flipper (128x64, monochrome). Sert à vérifier le résultat d\'une action ou d\'un script.',
    inputSchema: obj({}),
  },
  {
    name: 'press_button',
    description: 'Appuie sur un bouton du Flipper, comme Mikha. Sert à naviguer dans les menus. Appui long sur back = quitter une app.',
    inputSchema: obj({
      key: { type: 'string', enum: ['up', 'down', 'left', 'right', 'ok', 'back'], description: 'Bouton à presser' },
      long: { type: 'boolean', description: 'Appui long (0,5 s) au lieu d\'un appui court' },
    }, ['key']),
  },
  {
    name: 'list_files',
    description: 'Liste un dossier de la carte SD. Exemples : /ext, /ext/apps/Scripts, /ext/apps/System.',
    inputSchema: obj({ path: path('Dossier, commence par /ext') }, ['path']),
  },
  {
    name: 'read_file',
    description: 'Lit un fichier de la carte SD (64 Ko max). Texte, ou base64 si binaire. Les dossiers nfc, lfrfid, ibutton, subghz et u2f demandent la validation de Mikha.',
    inputSchema: obj({ path: path('Fichier, commence par /ext') }, ['path']),
  },
  {
    name: 'write_file',
    description: 'Crée ou remplace un fichier texte (64 Ko max), seulement dans /ext/apps/Scripts/, /ext/apps_data/ ou /ext/asset_packs/ (packs Momentum : Anims, Icons, Fonts). Les dossiers manquants sont créés.',
    inputSchema: obj({
      path: path('Exemple : /ext/apps/Scripts/mon_script.js ou /ext/apps_data/mon_script/config.txt'),
      content: { type: 'string', description: 'Contenu du fichier' },
    }, ['path', 'content']),
  },
  {
    name: 'delete_file',
    description: 'Supprime un fichier (ou un dossier vide), seulement dans /ext/apps/Scripts/, /ext/apps_data/ ou /ext/asset_packs/.',
    inputSchema: obj({ path: path('Fichier à supprimer') }, ['path']),
  },
  {
    name: 'run_script',
    description: 'Lance un script JavaScript (mJS) de /ext/apps/Scripts/ sur le Flipper. Mikha voit le code avant de valider. '
      + 'Ensuite : get_screen pour voir la sortie de print(), read_file pour lire les fichiers que le script a écrits, '
      + 'press_button back (long) pour quitter.',
    inputSchema: obj({ path: path('Exemple : /ext/apps/Scripts/mon_script.js') }, ['path']),
  },
  {
    name: 'catalog_search',
    description: 'Cherche dans le catalogue officiel d\'applications Flipper (catalog.flipperzero.one, le même que l\'app mobile officielle). '
      + 'Renvoie les apps compatibles avec le firmware de Mikha (id, nom, auteur, catégorie, version). Sers-toi de « installable » : false = pas de build pour cette API.',
    inputSchema: obj({
      query: { type: 'string', description: 'Mots-clés, ex. « unitemp », « marauder », « jeu »' },
      category_id: { type: 'string', description: 'Facultatif : filtrer par catégorie' },
    }),
  },
  {
    name: 'install_catalog_app',
    description: 'Installe sur le Flipper une app du catalogue officiel (id renvoyé par catalog_search). Mikha valide (il voit le nom, l\'auteur, la catégorie). '
      + 'C\'est un binaire vérifié par Flipper, pas de code source. Ensuite start_app avec le chemin pour la lancer.',
    inputSchema: obj({ id: { type: 'string', description: 'id de l\'app (de catalog_search)' } }, ['id']),
  },
  {
    name: 'build_app',
    description: 'Compile une app C pour le firmware actuel du Flipper (SDK officiel ou Momentum, choisi automatiquement) dans un conteneur isolé sur le VPS. '
      + 'files : {"application.fam": "...", "mon_app.c": "..."} (texte). Renvoie build_id, appid, taille et le journal '
      + '(erreurs du compilateur à corriger). N\'installe rien : ensuite install_app.',
    inputSchema: obj({
      files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Chemin relatif -> contenu texte' },
    }, ['files']),
  },
  {
    name: 'github_build',
    description: 'Compile une app C d\'un dépôt GitHub PUBLIC pour le Flipper (même compilateur isolé que build_app). '
      + 'repo : « owner/nom » ; ref : branche, tag ou commit (défaut : branche principale) ; path : dossier de l\'app '
      + 'si application.fam n\'est pas à la racine (en cas de doute, l\'erreur liste les dossiers possibles). '
      + 'Renvoie build_id comme build_app : ensuite install_app (Mikha valide et voit le code). Limite : 50 fichiers, 512 Ko.',
    inputSchema: obj({
      repo: { type: 'string', description: 'owner/nom, ex. flipperdevices/flipperzero-good-faps' },
      ref: { type: 'string', description: 'Branche, tag ou commit (optionnel)' },
      path: { type: 'string', description: 'Dossier de l\'app dans le dépôt (optionnel)' },
    }, ['repo']),
  },
  {
    name: 'install_app',
    description: 'Installe sur le Flipper une app compilée par build_app (Mikha valide, il voit le code). '
      + 'Elle va dans /ext/apps/<category>/<appid>.fap. Ensuite start_app avec ce chemin pour la lancer, get_screen pour vérifier.',
    inputSchema: obj({
      build_id: { type: 'string', description: 'Renvoyé par build_app' },
      category: { type: 'string', description: 'Dossier : Tools (défaut), Games, GPIO, Misc…' },
    }, ['build_id']),
  },
  {
    name: 'update_firmware',
    description: 'Installe ou met à jour le firmware du Flipper par Bluetooth, comme l\'app officielle : le VPS télécharge le paquet '
      + '(seulement depuis l\'index officiel, Unleashed ou Momentum), vérifie son empreinte, le téléphone le copie puis le Flipper '
      + 'redémarre et s\'installe. Mikha valide TOUJOURS (même en mode autonome). Seulement si Mikha l\'a demandé. '
      + 'Long (plusieurs minutes de copie). Ensuite, attends la reconnexion et vérifie le firmware (ligne « Firmware actuel »).',
    inputSchema: obj({
      firmware: { type: 'string', enum: ['official', 'unleashed', 'momentum'], description: 'official, unleashed ou momentum' },
      channel: { type: 'string', enum: ['release', 'rc', 'development'], description: 'Canal (défaut release)' },
    }, ['firmware']),
  },
  {
    name: 'backup',
    description: 'Sauvegardes de dossiers de la carte SD sur le VPS. action=save + path (ex. /ext/dolphin, les animations) : '
      + 'copie tout le dossier ; action=list : sauvegardes existantes ; action=restore + name : remet les fichiers sur le Flipper '
      + '(Mikha valide une fois pour tout le lot). Sauvegarde avant un changement de firmware.',
    inputSchema: obj({
      action: { type: 'string', enum: ['save', 'list', 'restore'] },
      path: { type: 'string', description: 'save : dossier, ex. /ext/dolphin' },
      name: { type: 'string', description: 'restore : nom renvoyé par save ou list' },
    }, ['action']),
  },
  {
    name: 'memory_search',
    description: 'Cherche dans la mémoire partagée (notes du brain sur ce Flipper : protocole, leçons, réussites, pièges). '
      + 'À faire avant une tâche nouvelle. Renvoie des notes (path, titre, résumé).',
    inputSchema: obj({ query: { type: 'string', description: 'Mots-clés, ex. « script js écran » ou « installation fap »' } }, ['query']),
  },
  {
    name: 'memory_read',
    description: 'Lit une note de la mémoire partagée (path renvoyé par memory_search).',
    inputSchema: obj({ path: { type: 'string', description: 'Chemin de la note' } }, ['path']),
  },
  {
    name: 'memory_note',
    description: 'Consigne une découverte durable pour les autres modèles (ce qui marche, un piège, une API). '
      + 'Elle devient un brouillon relu par le curateur. Pas pour les détails d\'une seule conversation.',
    inputSchema: obj({
      title: { type: 'string', description: 'Titre court et précis (120 caractères max)' },
      content: { type: 'string', description: 'Le fait, le contexte, la règle à retenir (4000 caractères max)' },
    }, ['title', 'content']),
  },
  {
    name: 'start_app',
    description: 'Ouvre une app du Flipper par son nom ou le chemin de son .fap, avec un argument facultatif (souvent un fichier à ouvrir).',
    inputSchema: obj({
      name: { type: 'string', description: 'Nom de l\'app ou chemin /ext/apps/.../x.fap' },
      args: { type: 'string', description: 'Argument facultatif' },
    }, ['name']),
  },
];

export const toolNames = () => TOOLS.map((t) => t.name);

// Format « function calling » d'Ollama.
export const ollamaTools = () => TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

// Version courte des arguments pour l'affichage (le contenu d'un fichier peut être long).
export function shrinkArgs(args) {
  const a = { ...(args || {}) };
  if (typeof a.content === 'string') a.content = '(' + a.content.length + ' caractères)';
  if (a.files && typeof a.files === 'object') {
    a.files = Object.fromEntries(Object.entries(a.files).map(([k, v]) => [k, '(' + String(v).length + ' caractères)']));
  }
  return a;
}
