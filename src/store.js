'use strict';
// Stockage simple en fichiers JSON : aucune base de données à installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.resolve(process.env.RAZE_DATA_DIR || path.join(__dirname, '..', 'data'));
const MAX_EXECUTIONS = Number(process.env.RAZE_MAX_EXECUTIONS || 200);
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

const dirs = {
  workflows: path.join(DATA_DIR, 'workflows'),
  executions: path.join(DATA_DIR, 'executions'),
  files: path.join(DATA_DIR, 'files'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

function file(kind, id) {
  if (!ID.test(String(id))) throw Object.assign(new Error('Identifiant invalide'), { status: 400 });
  return path.join(dirs[kind], `${id}.json`);
}
function read(kind, id) {
  try {
    return JSON.parse(fs.readFileSync(file(kind, id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
function write(kind, id, data) {
  const target = file(kind, id);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target); // écriture atomique
}
function list(kind) {
  return fs.readdirSync(dirs[kind]).filter((f) => f.endsWith('.json'))
    .map((f) => read(kind, f.slice(0, -5))).filter(Boolean);
}
function remove(kind, id) {
  try { fs.unlinkSync(file(kind, id)); return true; } catch { return false; }
}

function normalizeWorkflow(input, existing = {}) {
  const now = new Date().toISOString();
  const nodes = Array.isArray(input.nodes) ? input.nodes : existing.nodes || [];
  const edges = Array.isArray(input.edges) ? input.edges : existing.edges || [];
  return {
    id: existing.id || crypto.randomUUID(),
    name: String(input.name ?? existing.name ?? 'Nouveau workflow').slice(0, 120) || 'Sans titre',
    active: Boolean(input.active ?? existing.active ?? false),
    nodes: nodes.map((n) => ({
      id: String(n.id || crypto.randomUUID()),
      type: String(n.type),
      name: String(n.name || n.type).slice(0, 80),
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
      params: n.params && typeof n.params === 'object' ? n.params : {},
      continueOnFail: Boolean(n.continueOnFail),
    })),
    edges: edges.map((e) => ({
      id: String(e.id || crypto.randomUUID()),
      from: String(e.from),
      fromOutput: Number(e.fromOutput) || 0,
      to: String(e.to),
    })),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

const workflows = {
  list: () => list('workflows').sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
  get: (id) => read('workflows', id),
  create(input) { const wf = normalizeWorkflow(input); write('workflows', wf.id, wf); return wf; },
  update(id, input) {
    const existing = read('workflows', id);
    if (!existing) return null;
    const wf = normalizeWorkflow(input, existing);
    write('workflows', id, wf);
    return wf;
  },
  remove: (id) => remove('workflows', id),
};

const executions = {
  list(workflowId) {
    return list('executions')
      .filter((e) => !workflowId || e.workflowId === workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(({ nodes, ...summary }) => summary);
  },
  get: (id) => read('executions', id),
  save(exec) {
    write('executions', exec.id, exec);
    const all = list('executions').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const old of all.slice(MAX_EXECUTIONS)) remove('executions', old.id);
  },
  clear(workflowId) {
    for (const e of list('executions')) if (!workflowId || e.workflowId === workflowId) remove('executions', e.id);
  },
};

module.exports = { workflows, executions, DATA_DIR, FILES_DIR: dirs.files };
