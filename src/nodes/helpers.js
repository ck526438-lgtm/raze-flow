'use strict';

/** Exécute une fonction pour chaque élément ; retourne un élément, un tableau, ou null (élément retiré). */
function perItem(fn) {
  return async (ctx) => {
    const out = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const r = await fn(ctx.items[i], ctx.params(i), ctx, i);
      if (Array.isArray(r)) out.push(...r);
      else if (r != null) out.push(r);
    }
    return [out];
  };
}

/** Convertit un champ « clé / valeur » ([{key, value}]) en objet. */
function kvToObject(rows) {
  const out = {};
  if (Array.isArray(rows)) {
    for (const r of rows) if (r && r.key) out[r.key] = r.value;
  } else if (typeof rows === 'string' && rows.trim()) {
    Object.assign(out, JSON.parse(rows));
  } else if (rows && typeof rows === 'object') {
    Object.assign(out, rows);
  }
  return out;
}

const OPERATORS = [
  { value: 'equals', label: 'est égal à' },
  { value: 'notEquals', label: 'est différent de' },
  { value: 'contains', label: 'contient' },
  { value: 'notContains', label: 'ne contient pas' },
  { value: 'startsWith', label: 'commence par' },
  { value: 'endsWith', label: 'finit par' },
  { value: 'gt', label: 'est supérieur à' },
  { value: 'gte', label: 'est supérieur ou égal à' },
  { value: 'lt', label: 'est inférieur à' },
  { value: 'lte', label: 'est inférieur ou égal à' },
  { value: 'regex', label: 'correspond à la regex' },
  { value: 'isEmpty', label: 'est vide' },
  { value: 'isNotEmpty', label: "n'est pas vide" },
  { value: 'isTrue', label: 'est vrai' },
  { value: 'isFalse', label: 'est faux' },
];

function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
}
const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const isNumeric = (v) => v !== '' && v != null && typeof v !== 'boolean' && !Number.isNaN(Number(v));

function compare(left, operator, right) {
  switch (operator) {
    case 'equals': return isNumeric(left) && isNumeric(right) ? Number(left) === Number(right) : str(left) === str(right);
    case 'notEquals': return !compare(left, 'equals', right);
    case 'contains': return Array.isArray(left) ? left.map(str).includes(str(right)) : str(left).includes(str(right));
    case 'notContains': return !compare(left, 'contains', right);
    case 'startsWith': return str(left).startsWith(str(right));
    case 'endsWith': return str(left).endsWith(str(right));
    case 'gt': return Number(left) > Number(right);
    case 'gte': return Number(left) >= Number(right);
    case 'lt': return Number(left) < Number(right);
    case 'lte': return Number(left) <= Number(right);
    case 'regex': return new RegExp(str(right)).test(str(left));
    case 'isEmpty': return isEmpty(left);
    case 'isNotEmpty': return !isEmpty(left);
    case 'isTrue': return left === true || left === 'true' || left === 1 || left === '1';
    case 'isFalse': return left === false || left === 'false' || left === 0 || left === '0' || left == null || left === '';
    default: throw new Error(`Opérateur inconnu : ${operator}`);
  }
}

const conditionFields = [
  { name: 'left', label: 'Valeur', type: 'string', default: '', placeholder: '{{ $json.statut }}' },
  { name: 'operator', label: 'Condition', type: 'select', default: 'equals', options: OPERATORS },
  { name: 'right', label: 'Comparer à', type: 'string', default: '', showIf: { operator: OPERATORS.slice(0, 11).map((o) => o.value) } },
];

async function httpJson(url, { method = 'POST', headers = {}, body, timeout = 30 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* texte brut */ }
  if (!res.ok) throw new Error(`HTTP ${res.status} : ${text.slice(0, 300)}`);
  return data;
}

module.exports = { perItem, kvToObject, compare, conditionFields, httpJson, OPERATORS };
