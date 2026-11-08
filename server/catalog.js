// Catalogue officiel d'applications Flipper (catalog.flipperzero.one) : recherche et installation.
// API relevée dans flipperdevices/lab.flipper.net (le site officiel). Les apps sont des BINAIRES
// compilés pour une version d'API : seules celles qui ont un build pour l'API du Flipper s'installent.
const slug = (s, max = 40) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
const SAFE_CAT = /^[A-Za-z0-9_-]{1,24}$/;
// Le catalogue renvoie « _id » (MongoDB) ; lab.flipper.net le convertit en « id » côté client. On accepte les deux.
const idOf = (o) => (o && (o._id || o.id)) || undefined;

// api : version d'API du firmware (texte) ou fonction qui la renvoie (firmware lu en direct par le téléphone).
export function createCatalog({ url, target = 'f7', api: apiOpt = '88.2', log, callPhone, now = () => Date.now() }) {
  const apiNow = () => String(typeof apiOpt === 'function' ? apiOpt() : apiOpt);
  const base = url.replace(/\/$/, '');
  let cats = null; // id -> name
  let catsAt = 0;

  async function get(path, params, { binary = false } = {}) {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') u.searchParams.set(k, v);
    const res = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { accept: binary ? 'application/octet-stream' : 'application/json' } });
    if (binary) {
      if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try { detail = (JSON.parse(await res.text()).detail || {}).code || detail; } catch { /* corps binaire */ }
        throw new Error('build indisponible (' + detail + ')');
      }
      return Buffer.from(await res.arrayBuffer());
    }
    if (!res.ok) {
      // Le détail renvoyé par le catalogue dit quel paramètre est refusé : on le garde pour le diagnostic.
      let detail = '';
      try { detail = JSON.stringify(JSON.parse(await res.text()).detail ?? '').slice(0, 200); } catch { /* corps non JSON */ }
      throw new Error('catalogue : HTTP ' + res.status + (detail && detail !== '""' ? ' ' + detail : ''));
    }
    return res.json();
  }

  async function categories() {
    if (cats && now() - catsAt < 3600000) return cats;
    try {
      const list = await get('/category', { limit: 500 });
      cats = new Map((Array.isArray(list) ? list : []).map((c) => [idOf(c), c.name]));
      catsAt = now();
    } catch (e) {
      log('WARN', 'catalogue : catégories non lues (' + e.message + ')');
      cats = cats || new Map();
    }
    return cats;
  }

  // Dossier d'installation à partir du nom de catégorie du catalogue (sinon « Apps »).
  function catFolder(name) {
    const s = slug(name, 24);
    return SAFE_CAT.test(s) ? s : 'Apps';
  }

  async function search(args) {
    const api = apiNow();
    const query = typeof args.query === 'string' ? args.query.slice(0, 80) : '';
    let list, catMap;
    try {
      [list, catMap] = await Promise.all([
        // Mêmes paramètres que lab.flipper.net : is_latest_release_version n'est JAMAIS envoyé avec api/target
        // (refus HTTP 400), et le tri est toujours précisé (updated_at ; « downloads » n'existe pas).
        get('/0/application', {
          target, api,
          query, category_id: typeof args.category_id === 'string' ? args.category_id : undefined,
          limit: 20, offset: 0, sort_by: 'updated_at', sort_order: -1,
        }),
        categories(),
      ]);
    } catch (e) {
      return { ok: false, error: 'catalogue injoignable : ' + e.message };
    }
    const apps = (Array.isArray(list) ? list : []).map((a) => {
      const v = a.current_version || {};
      const build = v.current_build || {};
      return {
        id: idOf(a),
        name: v.name || a.alias,
        author: a.author,
        category: catMap.get(a.category_id) || '',
        version: v.version,
        description: (v.short_description || '').slice(0, 200),
        build_api: (build.sdk || {}).api,
        installable: !!idOf(build) && !!idOf(a),
      };
    });
    return { ok: true, result: { api, apps, hint: 'install_catalog_app avec id pour installer (Mikha valide)' } };
  }

  async function install(args, origin) {
    const api = apiNow();
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) return { ok: false, error: 'id d\'app requis (donné par catalog_search)' };
    let app, catMap;
    try {
      [app, catMap] = await Promise.all([
        get('/application/' + encodeURIComponent(id), { target, api }),
        categories(),
      ]);
    } catch (e) {
      return { ok: false, error: 'app introuvable dans le catalogue : ' + e.message };
    }
    const v = app && app.current_version;
    const build = v && v.current_build;
    if (!v || !idOf(v) || !idOf(build)) return { ok: false, error: 'pas de version compatible avec l\'API ' + api + ' (le catalogue n\'a pas de build pour ce firmware)' };
    const alias = slug(app.alias || (v.name || 'app'));
    if (!alias) return { ok: false, error: 'alias d\'app invalide' };
    let fap;
    try {
      fap = await get('/application/version/' + encodeURIComponent(idOf(v)) + '/build/compatible', { target, api }, { binary: true });
    } catch (e) {
      return { ok: false, error: 'téléchargement impossible : ' + e.message };
    }
    if (fap.length > 1024 * 1024) return { ok: false, error: 'app trop grosse (' + fap.length + ' octets)' };
    const category = catFolder(catMap.get(app.category_id));
    const path = '/ext/apps/' + category + '/' + alias + '.fap';
    log('INFO', 'catalogue : ' + (v.name || alias) + ' (' + fap.length + ' octets) -> ' + path);
    return callPhone('install_fap', {
      path, appid: alias, size: fap.length, base64: fap.toString('base64'),
      catalog: {
        name: v.name || alias, author: app.author || 'inconnu', category: catMap.get(app.category_id) || category,
        version: v.version || '', build_api: (build.sdk || {}).api || api,
      },
    }, origin, { timeoutMs: 300000 });
  }

  return { search, install };
}
