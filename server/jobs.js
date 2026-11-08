// Tâches longues (sauvegarde, restauration, firmware : plusieurs minutes de Bluetooth) lancées en fond, pour ne
// pas bloquer le tour du modèle (Claude est coupé au bout de quelques minutes et perdait le fil). L'outil répond
// tout de suite ; à la fin, onDone reçoit le résultat (bulle dans le chat, et note donnée au modèle à son
// prochain message). Une seule tâche à la fois : elles passent toutes par la même liaison Bluetooth.
export function createJobs({ log, onDone, now = () => Date.now() }) {
  const jobs = new Map(); // id -> { label, origin, started, status, result }
  let n = 0;

  const summarize = (r) => {
    if (!r) return 'aucun résultat';
    if (!r.ok) return String(r.error || 'échec').slice(0, 400);
    return typeof r.result === 'string' ? r.result.slice(0, 400) : JSON.stringify(r.result).slice(0, 400);
  };

  function start(label, origin, fn) {
    for (const [id, j] of jobs) {
      if (j.status === 'running') return { ok: false, error: 'une tâche de fond est déjà en cours (' + j.label + ', ' + id + ') : attends son résultat' };
    }
    const id = 'job' + (++n);
    const job = { label, origin, started: now(), status: 'running', result: null };
    jobs.set(id, job);
    while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
    log('INFO', 'tâche ' + id + ' : ' + label);
    Promise.resolve()
      .then(fn)
      .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
      .then((r) => {
        job.status = r && r.ok ? 'done' : 'failed';
        job.result = r;
        const secs = Math.round((now() - job.started) / 1000);
        const text = label + (r && r.ok ? ' : terminé' : ' : échec') + ' (' + secs + ' s). ' + summarize(r);
        log(r && r.ok ? 'INFO' : 'WARN', 'tâche ' + id + ' : ' + text);
        try { onDone({ id, label, origin, ok: !!(r && r.ok), text, result: r }); } catch (e) { log('ERROR', 'tâche ' + id + ' : ' + e.message); }
      });
    return {
      ok: true,
      result: {
        started: true, job: id,
        info: 'Tâche de fond lancée (' + label + '). Mikha voit la progression sur son téléphone ; le résultat s\'affichera dans le chat '
          + 'et te sera donné à ton prochain message. Ne la relance pas : réponds à Mikha maintenant.',
      },
    };
  }

  return { start };
}
