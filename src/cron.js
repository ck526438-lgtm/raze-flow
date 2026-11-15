'use strict';
// Mini analyseur cron à 5 champs : minute heure jour-du-mois mois jour-de-la-semaine
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(field, min, max) {
  const set = new Set();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`Champ cron invalide : « ${part} »`);
    let [lo, hi] = [min, max];
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b === undefined ? (m[2] ? max : a) : b;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`Champ cron hors limites : « ${part} »`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parse(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Une expression cron doit avoir 5 champs (ex. « */5 * * * * »)');
  const sets = fields.map((f, i) => parseField(f, RANGES[i][0], RANGES[i][1]));
  if (sets[4].has(7)) sets[4].add(0); // 7 = dimanche
  return { sets, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

function matches(expr, date = new Date()) {
  const { sets, domAny, dowAny } = typeof expr === 'string' ? parse(expr) : expr;
  if (!sets[0].has(date.getMinutes()) || !sets[1].has(date.getHours()) || !sets[3].has(date.getMonth() + 1)) return false;
  const dom = sets[2].has(date.getDate());
  const dow = sets[4].has(date.getDay());
  // Règle cron classique : si les deux sont restreints, l'un OU l'autre suffit
  if (!domAny && !dowAny) return dom || dow;
  return dom && dow;
}

module.exports = { parse, matches };
