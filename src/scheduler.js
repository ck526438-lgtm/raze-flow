'use strict';
// Planificateur : déclenche les workflows actifs contenant un nœud « Planification ».
const cron = require('./cron');

const UNITS = { seconds: 1000, minutes: 60000, hours: 3600000 };
const MIN_INTERVAL_MS = 5000;

function createScheduler({ listWorkflows, run, log = console }) {
  let timers = [];
  let cronJobs = [];
  let ticker = null;
  let lastMinute = null;
  const running = new Set();

  async function fire(workflowId, nodeId) {
    const key = `${workflowId}:${nodeId}`;
    if (running.has(key)) return; // l'exécution précédente n'est pas terminée
    running.add(key);
    try { await run(workflowId, nodeId); } catch (err) { log.error(`[planification] ${err.message}`); } finally { running.delete(key); }
  }

  function sync() {
    timers.forEach(clearInterval);
    timers = [];
    cronJobs = [];
    for (const wf of listWorkflows()) {
      if (!wf.active) continue;
      for (const node of wf.nodes) {
        if (node.type !== 'schedule') continue;
        const p = node.params || {};
        try {
          if (p.mode === 'cron') {
            cronJobs.push({ workflowId: wf.id, nodeId: node.id, parsed: cron.parse(p.cron ?? '0 8 * * *') });
          } else {
            const ms = Math.max((Number(p.every) || 5) * (UNITS[p.unit] || UNITS.minutes), MIN_INTERVAL_MS);
            const t = setInterval(() => fire(wf.id, node.id), ms);
            t.unref?.();
            timers.push(t);
          }
        } catch (err) {
          log.error(`[planification] « ${wf.name} » ignoré : ${err.message}`);
        }
      }
    }
    if (!ticker) {
      ticker = setInterval(() => {
        const now = new Date();
        const minute = Math.floor(now.getTime() / 60000);
        if (minute === lastMinute) return;
        lastMinute = minute;
        for (const job of cronJobs) if (cron.matches(job.parsed, now)) fire(job.workflowId, job.nodeId);
      }, 15000);
      ticker.unref?.();
    }
    return { intervals: timers.length, crons: cronJobs.length };
  }

  function stop() {
    timers.forEach(clearInterval);
    clearInterval(ticker);
    timers = []; cronJobs = []; ticker = null;
  }

  return { sync, stop };
}

module.exports = { createScheduler };
