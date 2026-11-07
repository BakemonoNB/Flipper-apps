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
