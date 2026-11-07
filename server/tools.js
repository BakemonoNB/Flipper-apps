// Outils proposés aux modèles (description + schéma des arguments).
// Le téléphone garde sa propre liste et décide du niveau de chaque outil :
// un outil décrit ici mais inconnu du téléphone sera refusé par lui.
export const TOOLS = [
  {
    name: 'ping',
    description: 'Vérifie que le Flipper Zero répond, par un aller-retour Bluetooth. Renvoie la latence en millisecondes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const toolNames = () => TOOLS.map((t) => t.name);

// Format « function calling » d'Ollama.
export const ollamaTools = () => TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));
