'use strict';
const vm = require('node:vm');
const { perItem, kvToObject, compare, conditionFields } = require('./helpers');
const { getPath } = require('../expressions');

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

module.exports = [
  // ───────────── Déclencheurs ─────────────
  {
    type: 'manual', label: 'Déclencheur manuel', group: 'trigger', icon: '▶️',
    description: 'Démarre le workflow quand vous cliquez sur « Exécuter ».',
    inputs: 0, outputs: ['sortie'], fields: [],
    run: ({ items }) => [items],
  },
  {
    type: 'webhook', label: 'Webhook', group: 'trigger', icon: '🪝',
    description: 'Démarre le workflow quand une requête HTTP arrive sur /webhook/<chemin>.',
    inputs: 0, outputs: ['sortie'],
    fields: [
      { name: 'path', label: 'Chemin', type: 'string', default: 'mon-webhook', help: 'URL finale : /webhook/<chemin> (workflow actif requis)' },
      { name: 'method', label: 'Méthode', type: 'select', default: 'ANY', options: ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'responseMode', label: 'Réponse', type: 'select', default: 'lastNode', options: [
        { value: 'lastNode', label: 'Résultat du dernier nœud' },
        { value: 'immediate', label: 'Immédiate (exécution en arrière-plan)' },
      ] },
    ],
    run: ({ items }) => [items],
  },
  {
    type: 'schedule', label: 'Planification', group: 'trigger', icon: '⏰',
    description: 'Démarre le workflow à intervalle régulier ou selon une expression cron.',
    inputs: 0, outputs: ['sortie'],
    fields: [
      { name: 'mode', label: 'Mode', type: 'select', default: 'interval', options: [
        { value: 'interval', label: 'Intervalle' }, { value: 'cron', label: 'Cron' },
      ] },
      { name: 'every', label: 'Toutes les', type: 'number', default: 5, showIf: { mode: ['interval'] } },
      { name: 'unit', label: 'Unité', type: 'select', default: 'minutes', showIf: { mode: ['interval'] }, options: [
        { value: 'seconds', label: 'secondes' }, { value: 'minutes', label: 'minutes' }, { value: 'hours', label: 'heures' },
      ] },
      { name: 'cron', label: 'Expression cron', type: 'string', default: '0 8 * * *', showIf: { mode: ['cron'] }, help: 'minute heure jour mois jour-semaine — ex. « 0 8 * * 1-5 » = 8h du lundi au vendredi' },
    ],
    run: ({ items }) => [items.map((i) => ({ timestamp: new Date().toISOString(), ...i }))],
  },

  // ───────────── Actions de base ─────────────
  {
    type: 'http', label: 'Requête HTTP', group: 'core', icon: '🌐',
    description: "Appelle n'importe quelle API ou page web.",
    outputs: ['sortie'],
    fields: [
      { name: 'method', label: 'Méthode', type: 'select', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      { name: 'url', label: 'URL', type: 'string', default: '', placeholder: 'https://api.exemple.com/v1/…' },
      { name: 'headers', label: 'En-têtes', type: 'keyvalue', default: [] },
      { name: 'query', label: 'Paramètres de requête', type: 'keyvalue', default: [] },
      { name: 'bodyType', label: 'Type de corps', type: 'select', default: 'json', options: [
        { value: 'json', label: 'JSON' }, { value: 'form', label: 'Formulaire' }, { value: 'raw', label: 'Texte brut' },
      ], showIf: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
      { name: 'body', label: 'Corps', type: 'text', default: '', placeholder: '{ "nom": "{{ $json.nom }}" }', showIf: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
      { name: 'timeout', label: 'Délai max (secondes)', type: 'number', default: 30 },
      { name: 'failOnError', label: 'Échouer si le statut HTTP est une erreur (4xx/5xx)', type: 'boolean', default: true },
    ],
    run: perItem(async (item, p) => {
      if (!p.url) throw new Error("L'URL est obligatoire");
      const url = new URL(p.url);
      for (const [k, v] of Object.entries(kvToObject(p.query))) url.searchParams.append(k, v);
      const headers = {};
      for (const [k, v] of Object.entries(kvToObject(p.headers))) headers[k.toLowerCase()] = String(v);
      let body;
      if (!['GET', 'HEAD'].includes(p.method) && p.body !== '' && p.body != null) {
        if (p.bodyType === 'json') {
          body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
          try { JSON.parse(body); } catch { throw new Error("Le corps n'est pas un JSON valide"); }
          headers['content-type'] ??= 'application/json';
        } else if (p.bodyType === 'form') {
          const data = typeof p.body === 'string' ? JSON.parse(p.body) : p.body;
          body = new URLSearchParams(data).toString();
          headers['content-type'] ??= 'application/x-www-form-urlencoded';
        } else body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
      }
      const res = await fetch(url, { method: p.method, headers, body, signal: AbortSignal.timeout((Number(p.timeout) || 30) * 1000) });
      const text = p.method === 'HEAD' ? '' : await res.text();
      let data = text;
      if ((res.headers.get('content-type') || '').includes('json')) { try { data = JSON.parse(text); } catch { /* texte */ } }
      if (!res.ok && p.failOnError !== false) throw new Error(`HTTP ${res.status} : ${text.slice(0, 300)}`);
      return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), data };
    }),
  },
  {
    type: 'code', label: 'Code JavaScript', group: 'core', icon: '🧩',
    description: 'Transforme les données avec votre propre code JavaScript.',
    outputs: ['sortie'],
    fields: [
      { name: 'code', label: 'Code', type: 'code', default: "// « items » contient les éléments reçus.\n// Retournez un tableau d'objets.\nreturn items.map((item) => ({\n  ...item,\n  traite: true,\n}));\n" },
    ],
    async run({ items, params, context }) {
      const { code } = params(0);
      const logs = [];
      const sandbox = vm.createContext({
        items: clone(items), $items: clone(items), $node: context.$node, $env: context.$env,
        console: { log: (...a) => logs.push(a.map(String).join(' ')) },
        fetch, URL, URLSearchParams, setTimeout, clearTimeout, Buffer,
      });
      const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'code-node.js' });
      let timer;
      const result = await Promise.race([
        script.runInContext(sandbox, { timeout: 5000 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Délai dépassé (60 s)")), 60000); }),
      ]).finally(() => clearTimeout(timer));
      let out = result === undefined ? items : clone(result);
      if (!Array.isArray(out)) out = [out];
      return [out.filter((v) => v != null).map((v) => (typeof v === 'object' && !Array.isArray(v) ? v : { value: v }))];
    },
  },
  {
    type: 'set', label: 'Modifier les champs', group: 'core', icon: '✏️',
    description: 'Ajoute ou modifie des champs sur chaque élément.',
    outputs: ['sortie'],
    fields: [
      { name: 'fields', label: 'Champs', type: 'keyvalue', default: [], placeholder: '{{ $json.prenom }}' },
      { name: 'keep', label: 'Conserver les champs existants', type: 'boolean', default: true },
    ],
    run: perItem((item, p) => {
      const out = p.keep === false ? {} : { ...item };
      for (const [key, value] of Object.entries(kvToObject(p.fields))) {
        // Chemins « a.b.c » pris en charge
        const parts = key.split('.');
        let cur = out;
        for (const part of parts.slice(0, -1)) {
          if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
          cur = cur[part];
        }
        cur[parts.at(-1)] = value;
      }
      return out;
    }),
  },

  // ───────────── Logique / flux ─────────────
  {
    type: 'if', label: 'Si (condition)', group: 'flow', icon: '🔀',
    description: 'Envoie chaque élément vers « vrai » ou « faux » selon une condition.',
    outputs: ['vrai', 'faux'],
    fields: conditionFields,
    run({ items, params }) {
      const yes = [], no = [];
      items.forEach((item, i) => {
        const p = params(i);
        (compare(p.left, p.operator, p.right) ? yes : no).push(item);
      });
      return [yes, no];
    },
  },
  {
    type: 'filter', label: 'Filtrer', group: 'flow', icon: '🧹',
    description: 'Ne garde que les éléments qui respectent la condition.',
    outputs: ['sortie'], fields: conditionFields,
    run: perItem((item, p) => (compare(p.left, p.operator, p.right) ? item : null)),
  },
  {
    type: 'merge', label: 'Fusionner', group: 'flow', icon: '🔗',
    description: 'Rassemble les éléments venant de plusieurs branches.',
    outputs: ['sortie'], fields: [],
    run: ({ items }) => [items],
  },
  {
    type: 'wait', label: 'Attendre', group: 'flow', icon: '⏳',
    description: 'Met le workflow en pause quelques secondes.',
    outputs: ['sortie'],
    fields: [{ name: 'seconds', label: 'Secondes', type: 'number', default: 2, help: 'Maximum 300 secondes' }],
    async run({ items, params }) {
      const s = Math.min(Math.max(Number(params(0).seconds) || 0, 0), 300);
      await new Promise((r) => setTimeout(r, s * 1000));
      return [items];
    },
  },
  {
    type: 'splitOut', label: 'Séparer une liste', group: 'flow', icon: '🪓',
    description: "Transforme un champ contenant une liste en plusieurs éléments.",
    outputs: ['sortie'],
    fields: [{ name: 'field', label: 'Champ contenant la liste', type: 'string', default: 'data', placeholder: 'data.resultats' }],
    run: perItem((item, p) => {
      const list = getPath(item, p.field);
      if (!Array.isArray(list)) throw new Error(`Le champ « ${p.field} » n'est pas une liste`);
      return list.map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }));
    }),
  },
  {
    type: 'aggregate', label: 'Regrouper', group: 'flow', icon: '📦',
    description: 'Regroupe tous les éléments en un seul.',
    outputs: ['sortie'],
    fields: [{ name: 'field', label: 'Nom du champ de sortie', type: 'string', default: 'elements' }],
    run: ({ items, params }) => [[{ [params(0).field || 'elements']: items, total: items.length }]],
  },
  {
    type: 'limit', label: 'Limiter', group: 'flow', icon: '✂️',
    description: 'Ne garde que les N premiers éléments.',
    outputs: ['sortie'],
    fields: [{ name: 'max', label: "Nombre maximum d'éléments", type: 'number', default: 10 }],
    run: ({ items, params }) => [items.slice(0, Math.max(Number(params(0).max) || 0, 0))],
  },
  {
    type: 'sort', label: 'Trier', group: 'flow', icon: '↕️',
    description: 'Trie les éléments selon un champ.',
    outputs: ['sortie'],
    fields: [
      { name: 'field', label: 'Champ', type: 'string', default: '', placeholder: 'prix' },
      { name: 'order', label: 'Ordre', type: 'select', default: 'asc', options: [{ value: 'asc', label: 'Croissant' }, { value: 'desc', label: 'Décroissant' }] },
    ],
    run({ items, params }) {
      const { field, order } = params(0);
      const dir = order === 'desc' ? -1 : 1;
      return [[...items].sort((a, b) => {
        const x = getPath(a, field), y = getPath(b, field);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }) * dir;
      })];
    },
  },
  {
    type: 'dedupe', label: 'Supprimer les doublons', group: 'flow', icon: '🧬',
    description: 'Retire les éléments en double (selon un champ, ou l’élément entier).',
    outputs: ['sortie'],
    fields: [{ name: 'field', label: 'Champ à comparer (vide = élément entier)', type: 'string', default: '' }],
    run({ items, params }) {
      const { field } = params(0);
      const seen = new Set();
      return [items.filter((item) => {
        const key = JSON.stringify(field ? getPath(item, field) : item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })];
    },
  },
  {
    type: 'stop', label: 'Arrêter avec une erreur', group: 'flow', icon: '🛑',
    description: "Arrête le workflow et marque l'exécution en erreur.",
    outputs: [],
    fields: [{ name: 'message', label: "Message d'erreur", type: 'string', default: 'Workflow arrêté' }],
    run({ params }) { throw new Error(params(0).message || 'Workflow arrêté'); },
  },
];
