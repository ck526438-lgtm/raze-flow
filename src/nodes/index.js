'use strict';
// Registre des nœuds. Pour créer un nœud : ajoutez un objet dans core.js / integrations.js
// (ou un nouveau fichier listé ici) avec { type, label, group, icon, description, outputs, fields, run }.
const registry = new Map();

function register(def) {
  if (registry.has(def.type)) throw new Error(`Nœud en double : ${def.type}`);
  registry.set(def.type, { inputs: 1, outputs: ['sortie'], fields: [], ...def });
}

for (const def of [...require('./core'), ...require('./integrations')]) register(def);

const getNodeType = (type) => registry.get(type);

/** Description des nœuds pour l'interface (sans la fonction run). */
function describeNodeTypes() {
  return [...registry.values()].map(({ run, ...def }) => ({
    ...def,
    fields: def.fields.map((f) => ({
      ...f,
      options: f.options?.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)),
    })),
  }));
}

module.exports = { register, getNodeType, describeNodeTypes };
