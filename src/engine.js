'use strict';
// Moteur d'exécution : parcourt le graphe depuis un déclencheur et exécute chaque nœud.
const crypto = require('node:crypto');
const { resolveValue } = require('./expressions');
const { getNodeType } = require('./nodes');

const MAX_STORED_ITEMS = 50;

function findStartNode(workflow, triggerNodeId) {
  if (triggerNodeId) return workflow.nodes.find((n) => n.id === triggerNodeId);
  const triggers = workflow.nodes.filter((n) => getNodeType(n.type)?.group === 'trigger');
  return triggers.find((n) => n.type === 'manual') || triggers[0]
    || workflow.nodes.find((n) => !workflow.edges.some((e) => e.to === n.id));
}

/** Ordre topologique des nœuds atteignables depuis le départ (les boucles sont refusées). */
function executionOrder(workflow, startId) {
  const reachable = new Set([startId]);
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    for (const e of workflow.edges) {
      if (e.from === id && !reachable.has(e.to)) { reachable.add(e.to); stack.push(e.to); }
    }
  }
  const edges = workflow.edges.filter((e) => reachable.has(e.from) && reachable.has(e.to));
  const indegree = new Map([...reachable].map((id) => [id, 0]));
  for (const e of edges) indegree.set(e.to, indegree.get(e.to) + 1);
  const queue = [...reachable].filter((id) => indegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      indegree.set(e.to, indegree.get(e.to) - 1);
      if (indegree.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length !== reachable.size) throw new Error('Le workflow contient une boucle : reliez les nœuds sans revenir en arrière.');
  return { order, edges };
}

function withDefaults(type, params) {
  const out = {};
  for (const f of type.fields || []) out[f.name] = params[f.name] ?? f.default;
  return out;
}

async function runWorkflow(workflow, { triggerNodeId, triggerData, mode = 'manual' } = {}) {
  const exec = {
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    mode,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    error: null,
    lastNodeId: null,
    nodes: {},
  };
  const t0 = Date.now();
  const outputs = new Map(); // nodeId -> [items[], items[], ...]
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));

  try {
    const start = findStartNode(workflow, triggerNodeId);
    if (!start) throw new Error('Aucun nœud à exécuter : ajoutez un déclencheur.');
    const { order, edges } = executionOrder(workflow, start.id);

    // $node["Nom du nœud"].json dans les expressions
    const nodeData = {};

    for (const id of order) {
      const node = byId.get(id);
      const type = getNodeType(node.type);
      const record = { status: 'running', startedAt: new Date().toISOString(), durationMs: 0, inputCount: 0, outputs: [], error: null };
      exec.nodes[id] = record;
      const tn = Date.now();

      let items;
      if (id === start.id) {
        items = [triggerData ?? {}];
      } else {
        items = [];
        for (const e of edges) if (e.to === id) items.push(...(outputs.get(e.from)?.[e.fromOutput] || []));
        if (items.length === 0) { record.status = 'skipped'; outputs.set(id, []); continue; }
      }
      record.inputCount = items.length;

      try {
        if (!type) throw new Error(`Type de nœud inconnu : ${node.type}`);
        const baseCtx = {
          $items: items,
          $node: nodeData,
          $env: process.env,
          $workflow: { id: workflow.id, name: workflow.name },
          $execution: { id: exec.id, mode },
        };
        const raw = withDefaults(type, node.params || {});
        const codeFields = new Set((type.fields || []).filter((f) => f.type === 'code').map((f) => f.name));
        const params = (index = 0) => {
          const ctx = { ...baseCtx, $json: items[index] ?? {}, $index: index, $now: new Date() };
          const out = {};
          for (const [k, v] of Object.entries(raw)) out[k] = codeFields.has(k) ? v : resolveValue(v, ctx);
          return out;
        };
        let result = await type.run({ items, params, node, workflow, execution: exec, context: baseCtx });
        if (!Array.isArray(result)) result = [[result]];
        else if (!result.every(Array.isArray)) result = [result];
        outputs.set(id, result);
        record.status = 'success';
      } catch (err) {
        record.error = err.message || String(err);
        if (node.continueOnFail) {
          outputs.set(id, [[{ error: record.error }]]);
          record.status = 'warning';
        } else {
          record.status = 'error';
          record.durationMs = Date.now() - tn;
          throw new Error(`[${node.name}] ${record.error}`);
        }
      }
      const out = outputs.get(id);
      record.durationMs = Date.now() - tn;
      record.outputs = out.map((arr) => arr.slice(0, MAX_STORED_ITEMS));
      record.outputCounts = out.map((arr) => arr.length);
      nodeData[node.name] = { json: out[0]?.[0] ?? {}, items: out[0] || [], outputs: out };
      exec.lastNodeId = id;
    }
    exec.status = Object.values(exec.nodes).some((n) => n.status === 'warning') ? 'warning' : 'success';
  } catch (err) {
    exec.status = 'error';
    exec.error = err.message || String(err);
  }
  exec.finishedAt = new Date().toISOString();
  exec.durationMs = Date.now() - t0;
  // Résultat complet (non tronqué) du dernier nœud, pour les réponses de webhook
  Object.defineProperty(exec, 'lastOutput', { value: outputs.get(exec.lastNodeId)?.[0] || [], enumerable: false });
  return exec;
}

module.exports = { runWorkflow, executionOrder, findStartNode };
