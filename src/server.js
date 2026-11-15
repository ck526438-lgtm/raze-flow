#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const store = require('./store');
const { runWorkflow, findStartNode } = require('./engine');
const { describeNodeTypes } = require('./nodes');
const { createScheduler } = require('./scheduler');

const PORT = Number(process.env.PORT || 5678);
const HOST = process.env.HOST || '127.0.0.1';
const USER = process.env.RAZE_USER;
const PASSWORD = process.env.RAZE_PASSWORD;
const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ['text/*', 'application/xml'], limit: '5mb' }));

async function execute(workflow, options) {
  const exec = await runWorkflow(workflow, options);
  store.executions.save(exec);
  return exec;
}

const scheduler = createScheduler({
  listWorkflows: () => store.workflows.list(),
  run: (workflowId, nodeId) => {
    const wf = store.workflows.get(workflowId);
    return wf && wf.active ? execute(wf, { triggerNodeId: nodeId, mode: 'schedule' }) : null;
  },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const normalizePath = (p) => String(p || '').trim().replace(/^\/+|\/+$/g, '');

// ───────────── Webhooks (publics : c'est leur rôle) ─────────────
app.all('/webhook/*', wrap(async (req, res) => {
  const wanted = normalizePath(req.params[0]);
  let match = null;
  for (const wf of store.workflows.list()) {
    if (!wf.active) continue;
    const node = wf.nodes.find((n) => n.type === 'webhook'
      && normalizePath(n.params?.path ?? 'mon-webhook') === wanted
      && ['ANY', undefined, req.method].includes(n.params?.method));
    if (node) { match = { wf, node }; break; }
  }
  if (!match) return res.status(404).json({ error: `Aucun workflow actif n'écoute sur /webhook/${wanted}` });

  const triggerData = { method: req.method, path: wanted, query: req.query, headers: req.headers, body: req.body ?? {} };
  const options = { triggerNodeId: match.node.id, triggerData, mode: 'webhook' };
  if (match.node.params?.responseMode === 'immediate') {
    execute(match.wf, options).catch((err) => console.error('[webhook]', err.message));
    return res.status(202).json({ ok: true, message: 'Workflow démarré' });
  }
  const exec = await execute(match.wf, options);
  if (exec.status === 'error') return res.status(500).json({ ok: false, error: exec.error, executionId: exec.id });
  const out = exec.lastOutput;
  res.json(out.length === 1 ? out[0] : out);
}));

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'RAZE Flow', version: require('../package.json').version }));

// ───────────── Protection par mot de passe (optionnelle) ─────────────
if (USER && PASSWORD) {
  const expected = Buffer.from(`${USER}:${PASSWORD}`);
  app.use((req, res, next) => {
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Basic\s+/i, ''), 'base64');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="RAZE Flow", charset="UTF-8"').status(401).send('Authentification requise');
  });
}

// ───────────── API ─────────────
app.get('/api/node-types', (req, res) => res.json(describeNodeTypes()));

app.get('/api/templates', (req, res) => {
  const files = fs.existsSync(EXAMPLES_DIR) ? fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort() : [];
  res.json(files.map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8'));
    return { file: f, name: t.name, description: t.description || '', workflow: t };
  }));
});

app.get('/api/workflows', (req, res) => {
  res.json(store.workflows.list().map((w) => ({ id: w.id, name: w.name, active: w.active, updatedAt: w.updatedAt, nodeCount: w.nodes.length })));
});
app.post('/api/workflows', (req, res) => {
  const wf = store.workflows.create({ ...req.body, active: false });
  res.status(201).json(wf);
});
app.get('/api/workflows/:id', (req, res) => {
  const wf = store.workflows.get(req.params.id);
  return wf ? res.json(wf) : res.status(404).json({ error: 'Workflow introuvable' });
});
app.put('/api/workflows/:id', (req, res) => {
  const wf = store.workflows.update(req.params.id, req.body || {});
  if (!wf) return res.status(404).json({ error: 'Workflow introuvable' });
  scheduler.sync();
  res.json(wf);
});
app.delete('/api/workflows/:id', (req, res) => {
  store.workflows.remove(req.params.id);
  store.executions.clear(req.params.id);
  scheduler.sync();
  res.json({ ok: true });
});
app.post('/api/workflows/:id/run', wrap(async (req, res) => {
  const wf = store.workflows.get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow introuvable' });
  const { triggerNodeId, data } = req.body || {};
  const start = findStartNode(wf, triggerNodeId);
  // Données d'essai pour tester un webhook depuis l'éditeur
  const sample = start?.type === 'webhook' && data === undefined
    ? { method: 'POST', path: start.params?.path, query: {}, headers: {}, body: { exemple: true } } : data;
  res.json(await execute(wf, { triggerNodeId, triggerData: sample, mode: 'manual' }));
}));

app.get('/api/executions', (req, res) => res.json(store.executions.list(req.query.workflowId)));
app.get('/api/executions/:id', (req, res) => {
  const e = store.executions.get(req.params.id);
  return e ? res.json(e) : res.status(404).json({ error: 'Exécution introuvable' });
});
app.delete('/api/executions', (req, res) => { store.executions.clear(req.query.workflowId); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Erreur interne' });
});

function start() {
  const server = app.listen(PORT, HOST, () => {
    const s = scheduler.sync();
    console.log(`\n  RAZE Flow est prêt →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${server.address().port}`);
    console.log(`  Données : ${store.DATA_DIR}`);
    console.log(`  Planifications actives : ${s.intervals + s.crons}`);
    if (!USER || !PASSWORD) console.log('  ⚠ Aucun mot de passe : définissez RAZE_USER et RAZE_PASSWORD avant d’exposer le serveur sur Internet.\n');
  });
  const shutdown = () => { scheduler.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { app, start, scheduler };
