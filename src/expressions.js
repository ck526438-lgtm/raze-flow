'use strict';
// Moteur d'expressions : {{ $json.champ }}, {{ $node["Nom"].json.x }}, {{ $now }}, etc.
const vm = require('node:vm');

const EXPR = /\{\{([\s\S]+?)\}\}/g;
const SINGLE = /^\s*\{\{((?:(?!\{\{)[\s\S])+?)\}\}\s*$/;

function evaluate(code, ctx) {
  try {
    const sandbox = vm.createContext({ ...ctx });
    return vm.runInContext(`(${code}\n)`, sandbox, { timeout: 1000 });
  } catch (err) {
    throw new Error(`Expression invalide « {{${code}}} » : ${err.message}`);
  }
}

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Résout récursivement toutes les expressions d'une valeur (chaîne, tableau, objet). */
function resolveValue(value, ctx) {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    const single = value.match(SINGLE);
    // Une seule expression : on garde le type d'origine (nombre, objet, tableau…)
    if (single) return evaluate(single[1], ctx);
    return value.replace(EXPR, (_, code) => stringify(evaluate(code, ctx)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx);
    return out;
  }
  return value;
}

/** Lit un chemin « a.b[0].c » dans un objet. */
function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

module.exports = { resolveValue, evaluate, getPath };
