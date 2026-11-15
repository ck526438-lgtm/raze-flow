'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.RAZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raze-test-'));

const { runWorkflow } = require('../src/engine');
const { resolveValue } = require('../src/expressions');
const cron = require('../src/cron');
const { compare } = require('../src/nodes/helpers');
const { describeNodeTypes } = require('../src/nodes');

const node = (id, type, params = {}, extra = {}) => ({ id, type, name: id, position: { x: 0, y: 0 }, params, ...extra });
const edge = (from, to, fromOutput = 0) => ({ id: `${from}-${to}-${fromOutput}`, from, to, fromOutput });
const wf = (nodes, edges) => ({ id: 'w1', name: 'Test', nodes, edges });

test('expressions : interpolation et type conservé', () => {
  const ctx = { $json: { nom: 'Awa', age: 30, tags: ['a', 'b'] } };
  assert.equal(resolveValue('Bonjour {{ $json.nom }} !', ctx), 'Bonjour Awa !');
  assert.equal(resolveValue('{{ $json.age + 1 }}', ctx), 31);
  assert.deepEqual(resolveValue('{{ $json.tags }}', ctx), ['a', 'b']);
  assert.deepEqual(resolveValue({ a: ['{{ $json.nom.toUpperCase() }}'] }, ctx), { a: ['AWA'] });
  assert.equal(resolveValue('{{ $json.a }}-{{ $json.age }}', ctx), '-30');
  assert.throws(() => resolveValue('{{ ceci n est pas valide }}', ctx), /Expression invalide/);
});

test('cron : correspondances', () => {
  const d = new Date(2026, 10, 16, 8, 0); // lundi 16 nov. 2026, 08:00
  assert.ok(cron.matches('0 8 * * *', d));
  assert.ok(cron.matches('*/5 * * * 1-5', d));
  assert.ok(!cron.matches('30 8 * * *', d));
  assert.ok(!cron.matches('0 8 * * 0', d));
  assert.ok(cron.matches('0 8 1 * 1', d)); // jour du mois OU jour de semaine
  assert.throws(() => cron.parse('* * *'), /5 champs/);
  assert.throws(() => cron.parse('99 * * * *'), /hors limites/);
});

test('conditions', () => {
  assert.ok(compare('10', 'equals', 10));
  assert.ok(compare('abc', 'contains', 'b'));
  assert.ok(compare(5, 'gt', '3'));
  assert.ok(compare([], 'isEmpty'));
  assert.ok(compare('x', 'isNotEmpty'));
  assert.ok(compare('abc123', 'regex', '^[a-z]+\\d+$'));
});

test('workflow : set → if avec branches, nœud ignoré et fusion', async () => {
  const exec = await runWorkflow(wf([
    node('start', 'manual'),
    node('code', 'code', { code: 'return [{ n: 1 }, { n: 5 }, { n: 9 }];' }),
    node('if', 'if', { left: '{{ $json.n }}', operator: 'gte', right: '5' }),
    node('grand', 'set', { fields: [{ key: 'taille', value: 'grand' }, { key: 'double', value: '{{ $json.n * 2 }}' }] }),
    node('petit', 'set', { fields: [{ key: 'taille', value: 'petit' }] }),
    node('fusion', 'merge'),
    node('orphelin', 'set'),
  ], [edge('start', 'code'), edge('code', 'if'), edge('if', 'grand', 0), edge('if', 'petit', 1), edge('grand', 'fusion'), edge('petit', 'fusion')]));
  assert.equal(exec.status, 'success', exec.error);
  assert.deepEqual(exec.nodes.if.outputCounts, [2, 1]);
  assert.deepEqual(exec.nodes.grand.outputs[0], [{ n: 5, taille: 'grand', double: 10 }, { n: 9, taille: 'grand', double: 18 }]);
  assert.equal(exec.nodes.fusion.outputs[0].length, 3);
  assert.equal(exec.nodes.orphelin, undefined);
  assert.equal(exec.lastNodeId, 'fusion');
});

test('workflow : une branche vide est ignorée', async () => {
  const exec = await runWorkflow(wf([
    node('start', 'manual'),
    node('if', 'if', { left: 'a', operator: 'equals', right: 'b' }),
    node('oui', 'set'), node('non', 'set'),
  ], [edge('start', 'if'), edge('if', 'oui', 0), edge('if', 'non', 1)]));
  assert.equal(exec.nodes.oui.status, 'skipped');
  assert.equal(exec.nodes.non.status, 'success');
});

test('workflow : erreur, puis « continuer si erreur »', async () => {
  const build = (extra) => wf([node('start', 'manual'), node('boom', 'code', { code: 'throw new Error("aïe")' }, extra), node('suite', 'set')],
    [edge('start', 'boom'), edge('boom', 'suite')]);
  const failed = await runWorkflow(build({}));
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /aïe/);
  assert.equal(failed.nodes.suite, undefined);
  const cont = await runWorkflow(build({ continueOnFail: true }));
  assert.equal(cont.status, 'warning');
  assert.match(cont.nodes.suite.outputs[0][0].error, /aïe/);
});

test('workflow : boucle refusée', async () => {
  const exec = await runWorkflow(wf([node('start', 'manual'), node('a', 'set'), node('b', 'set')],
    [edge('start', 'a'), edge('a', 'b'), edge('b', 'a')]));
  assert.equal(exec.status, 'error');
  assert.match(exec.error, /boucle/);
});

test('workflow : données du déclencheur et $node', async () => {
  const exec = await runWorkflow(wf([
    node('hook', 'webhook'),
    node('a', 'set', { fields: [{ key: 'x', value: '{{ $json.body.prix * 2 }}' }], keep: false }),
    node('b', 'set', { fields: [{ key: 'origine', value: '{{ $node["hook"].json.body.prix }}' }] }),
  ], [edge('hook', 'a'), edge('a', 'b')]), { triggerNodeId: 'hook', triggerData: { body: { prix: 21 } }, mode: 'webhook' });
  assert.deepEqual(exec.lastOutput, [{ x: 42, origine: 21 }]);
});

test('nœuds de liste : séparer, trier, limiter, doublons, regrouper, filtrer', async () => {
  const exec = await runWorkflow(wf([
    node('start', 'manual'),
    node('data', 'code', { code: 'return { liste: [{p:3},{p:1},{p:2},{p:1},{p:7}] };' }),
    node('split', 'splitOut', { field: 'liste' }),
    node('dedupe', 'dedupe', { field: 'p' }),
    node('filter', 'filter', { left: '{{ $json.p }}', operator: 'lt', right: '7' }),
    node('sort', 'sort', { field: 'p', order: 'desc' }),
    node('limit', 'limit', { max: 2 }),
    node('agg', 'aggregate', { field: 'top' }),
  ], [edge('start', 'data'), edge('data', 'split'), edge('split', 'dedupe'), edge('dedupe', 'filter'), edge('filter', 'sort'), edge('sort', 'limit'), edge('limit', 'agg')]));
  assert.equal(exec.status, 'success', exec.error);
  assert.deepEqual(exec.lastOutput, [{ top: [{ p: 3 }, { p: 2 }], total: 2 }]);
});

test('requête HTTP + fichiers', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/ko')) { res.writeHead(500); return res.end('panne'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, method: req.method, recu: body ? JSON.parse(body) : null, auth: req.headers['x-cle'] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await runWorkflow(wf([
      node('start', 'manual'),
      node('req', 'http', { method: 'POST', url: `${base}/api`, headers: [{ key: 'X-Cle', value: 'secret' }], query: [{ key: 'q', value: 'thé vert' }], body: '{ "mode": "{{ $execution.mode }}" }' }),
      node('save', 'writeFile', { name: 'out/res.json', content: '{{ $json.data }}' }),
      node('load', 'readFile', { name: 'out/res.json' }),
    ], [edge('start', 'req'), edge('req', 'save'), edge('save', 'load')]));
    assert.equal(ok.status, 'success', ok.error);
    const contenu = ok.lastOutput[0].contenu;
    assert.equal(contenu.method, 'POST');
    assert.equal(contenu.auth, 'secret');
    assert.deepEqual(contenu.recu, { mode: 'manual' });
    assert.match(contenu.url, /q=th%C3%A9\+vert/);

    const ko = await runWorkflow(wf([node('start', 'manual'), node('req', 'http', { url: `${base}/ko` })], [edge('start', 'req')]));
    assert.equal(ko.status, 'error');
    assert.match(ko.error, /HTTP 500/);

    const evasion = await runWorkflow(wf([node('start', 'manual'), node('f', 'readFile', { name: '../../etc/passwd' })], [edge('start', 'f')]));
    assert.match(evasion.error, /invalide/);
  } finally { server.close(); }
});

test('commande système désactivée par défaut', async () => {
  delete process.env.RAZE_ALLOW_EXEC;
  const exec = await runWorkflow(wf([node('start', 'manual'), node('x', 'exec', { command: 'echo salut' })], [edge('start', 'x')]));
  assert.match(exec.error, /RAZE_ALLOW_EXEC/);
});

test('chaque type de nœud est bien décrit', () => {
  const types = describeNodeTypes();
  assert.ok(types.length >= 20);
  for (const t of types) {
    assert.ok(t.type && t.label && t.icon && t.description && t.group, t.type);
    for (const f of t.fields) assert.ok(f.name && f.label && f.type, `${t.type}.${f.name}`);
  }
});
