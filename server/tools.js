// Outils proposés aux modèles (description + schéma des arguments).
// Le téléphone garde sa propre liste et décide du niveau de chaque outil :
// un outil décrit ici mais inconnu du téléphone sera refusé par lui.
export const TOOLS = [
  {
    name: 'ping',
    description: 'Vérifie que le Flipper Zero répond, par un aller-retour Bluetooth. Renvoie la latence en millisecondes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'press_button',
    description: 'Appuie sur un bouton du Flipper Zero, comme si Mikha le faisait. Sert à naviguer dans les menus. '
      + 'Mikha valide chaque appui sur son téléphone, sauf en mode autonome. Appui long sur back = quitter une app.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['up', 'down', 'left', 'right', 'ok', 'back'], description: 'Bouton à presser' },
        long: { type: 'boolean', description: 'Appui long (0,5 s) au lieu d\'un appui court' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
];

export const toolNames = () => TOOLS.map((t) => t.name);

// Format « function calling » d'Ollama.
export const ollamaTools = () => TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));
