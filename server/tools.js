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
    description: 'Crée ou remplace un fichier texte (64 Ko max), seulement dans /ext/apps/Scripts/ ou /ext/apps_data/. Les dossiers manquants sont créés.',
    inputSchema: obj({
      path: path('Exemple : /ext/apps/Scripts/mon_script.js ou /ext/apps_data/mon_script/config.txt'),
      content: { type: 'string', description: 'Contenu du fichier' },
    }, ['path', 'content']),
  },
  {
    name: 'delete_file',
    description: 'Supprime un fichier (ou un dossier vide), seulement dans /ext/apps/Scripts/ ou /ext/apps_data/.',
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
    description: 'Compile une app C pour le Flipper (firmware officiel 1.5.1, API 88.2) dans un conteneur isolé sur le VPS. '
      + 'files : {"application.fam": "...", "mon_app.c": "..."} (texte). Renvoie build_id, appid, taille et le journal '
      + '(erreurs du compilateur à corriger). N\'installe rien : ensuite install_app.',
    inputSchema: obj({
      files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Chemin relatif -> contenu texte' },
    }, ['files']),
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
