/* RAZE Flow — éditeur de workflows (JavaScript pur, sans étape de build) */
'use strict';

const NODE_W = 200, NODE_H = 68;
const GROUPS = { trigger: 'Déclencheurs', core: 'Actions', flow: 'Logique', integration: 'Intégrations' };
const STATUS = { success: 'Réussie', error: 'Erreur', warning: 'Avec alertes', running: 'En cours' };
const MODES = { manual: 'manuel', webhook: 'webhook', schedule: 'planifié' };

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Crée un élément DOM (le texte passe toujours par textContent : pas d'injection HTML). */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svg = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2400);
}

// ───────────── État ─────────────
const state = {
  types: {},          // type -> définition
  workflows: [],      // liste résumée
  wf: null,           // workflow ouvert
  selectedNode: null,
  selectedEdge: null,
  pending: null,      // liaison en attente (mode « toucher puis toucher »)
  view: { x: 60, y: 60, k: 1 },
  exec: null,         // dernière exécution affichée
  dirty: false,
  running: false,
};

const wrap = $('#wrap'), canvas = $('#canvas'), nodesEl = $('#nodes'), edgesEl = $('#edges');
const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
const typeOf = (node) => state.types[node.type] || { label: node.type, icon: '❓', outputs: ['sortie'], inputs: 1, fields: [], group: 'core', description: 'Type de nœud inconnu' };
const nodeById = (id) => state.wf.nodes.find((n) => n.id === id);

function markDirty(v = true) {
  state.dirty = v;
  $('#btn-save').classList.toggle('dirty', v);
}

// ───────────── Vue (déplacement / zoom) ─────────────
function applyView() {
  const { x, y, k } = state.view;
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  wrap.style.backgroundPosition = `0 0, 0 0, ${x}px ${y}px`;
  wrap.style.backgroundSize = `auto, auto, ${24 * k}px ${24 * k}px`;
}
function toWorld(clientX, clientY) {
  const r = wrap.getBoundingClientRect();
  return { x: (clientX - r.left - state.view.x) / state.view.k, y: (clientY - r.top - state.view.y) / state.view.k };
}
function zoomAt(factor, clientX, clientY) {
  const r = wrap.getBoundingClientRect();
  const cx = (clientX ?? r.left + r.width / 2) - r.left, cy = (clientY ?? r.top + r.height / 2) - r.top;
  const k = Math.min(2, Math.max(0.25, state.view.k * factor));
  const ratio = k / state.view.k;
  state.view.x = cx - (cx - state.view.x) * ratio;
  state.view.y = cy - (cy - state.view.y) * ratio;
  state.view.k = k;
  applyView();
}
function fitView(all = false) {
  const nodes = state.wf?.nodes || [];
  const r = wrap.getBoundingClientRect();
  if (!nodes.length) { state.view = { x: 60, y: 60, k: 1 }; return applyView(); }
  const minX = Math.min(...nodes.map((n) => n.position.x)), maxX = Math.max(...nodes.map((n) => n.position.x + NODE_W));
  const minY = Math.min(...nodes.map((n) => n.position.y)), maxY = Math.max(...nodes.map((n) => n.position.y + NODE_H));
  const pad = isMobile() ? 24 : 60;
  const fit = Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY));
  const readable = isMobile() ? 0.7 : 0.55;
  if (!all && fit < readable) {
    // Trop grand pour rester lisible : on cadre le début du workflow, le reste se fait défiler
    const first = nodes.reduce((a, b) => (b.position.x < a.position.x ? b : a));
    state.view = { k: readable, x: pad - minX * readable, y: r.height * (isMobile() ? 0.3 : 0.5) - (first.position.y + NODE_H / 2) * readable };
  } else {
    const k = Math.min(1, Math.max(0.25, fit));
    state.view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
  }
  applyView();
}

// ───────────── Rendu du canevas ─────────────
function portPos(node, kind, index = 0) {
  if (kind === 'in') return { x: node.position.x, y: node.position.y + NODE_H / 2 };
  const n = typeOf(node).outputs.length || 1;
  return { x: node.position.x + NODE_W, y: node.position.y + (NODE_H * (index + 1)) / (n + 1) };
}
function curve(a, b) {
  const d = Math.max(50, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`;
}

function renderNodes() {
  nodesEl.replaceChildren();
  for (const node of state.wf.nodes) {
    const type = typeOf(node);
    const rec = state.exec?.nodes?.[node.id];
    const el = h('div', {
      class: ['node', type.group === 'trigger' && 'trigger', state.selectedNode === node.id && 'selected', rec && `s-${rec.status}`].filter(Boolean).join(' '),
      dataset: { id: node.id },
      style: { left: `${node.position.x}px`, top: `${node.position.y}px` },
    },
      type.inputs !== 0 && h('div', { class: 'port in' }),
      h('div', { class: 'node-ico' }, type.icon),
      h('div', { class: 'node-body' }, h('div', { class: 'node-name' }, node.name), h('div', { class: 'node-type' }, type.label)),
      type.outputs.map((label, i) => h('div', {
        class: `port out${state.pending?.from === node.id && state.pending.out === i ? ' pending' : ''}`,
        dataset: { out: i },
        style: { top: `${((i + 1) / (type.outputs.length + 1)) * 100}%` },
      }, type.outputs.length > 1 && h('span', { class: 'port-label' }, label))),
      rec && h('div', { class: 'badge' }, badgeText(rec)),
    );
    nodesEl.append(el);
  }
  $('#empty').hidden = state.wf.nodes.length > 0;
  renderEdges();
}
function badgeText(rec) {
  if (rec.status === 'error') return '✕ erreur';
  if (rec.status === 'skipped') return 'ignoré';
  const total = (rec.outputCounts || []).reduce((a, b) => a + b, 0);
  return `${rec.status === 'warning' ? '⚠' : '✓'} ${total}`;
}

function renderEdges() {
  edgesEl.replaceChildren();
  for (const e of state.wf.edges) {
    const from = nodeById(e.from), to = nodeById(e.to);
    if (!from || !to) continue;
    const d = curve(portPos(from, 'out', e.fromOutput), portPos(to, 'in'));
    const carried = state.exec?.nodes?.[e.from]?.outputCounts?.[e.fromOutput] > 0 && state.exec.nodes[e.to]?.status !== undefined;
    edgesEl.append(
      svg('path', { d, class: `edge${carried ? ' done' : ''}${state.selectedEdge === e.id ? ' selected' : ''}` }),
      svg('path', { d, class: 'edge-hit', 'data-edge': e.id }),
    );
  }
}

function showHint(text, actionLabel, action) {
  const bar = $('#hint-bar');
  if (!text) { bar.hidden = true; return; }
  bar.replaceChildren(h('span', null, text), actionLabel && h('button', { class: 'btn small danger', onclick: action }, actionLabel));
  bar.hidden = false;
}

// ───────────── Sélection ─────────────
function select({ node = null, edge = null } = {}) {
  state.selectedNode = node;
  state.selectedEdge = edge;
  renderNodes();
  renderPanel();
  if (node) ensureVisible(nodeById(node));
  if (edge) showHint('Lien sélectionné', '🗑 Supprimer', deleteSelection);
  else if (!state.pending) showHint(null);
}
function deleteSelection() {
  if (state.selectedEdge) {
    state.wf.edges = state.wf.edges.filter((e) => e.id !== state.selectedEdge);
  } else if (state.selectedNode) {
    const id = state.selectedNode;
    state.wf.nodes = state.wf.nodes.filter((n) => n.id !== id);
    state.wf.edges = state.wf.edges.filter((e) => e.from !== id && e.to !== id);
  } else return;
  markDirty();
  select();
}

// ───────────── Nœuds et liens ─────────────
function addNode(typeName) {
  const type = state.types[typeName];
  const names = new Set(state.wf.nodes.map((n) => n.name));
  let name = type.label, i = 2;
  while (names.has(name)) name = `${type.label} ${i++}`;
  const r = wrap.getBoundingClientRect();
  const center = toWorld(r.left + r.width / 2, r.top + r.height * (isMobile() ? 0.3 : 0.45));
  // Place le nouveau nœud à droite du nœud sélectionné (ou du dernier), sinon au centre
  const anchor = nodeById(state.selectedNode) || state.wf.nodes.at(-1);
  let pos = anchor ? { x: anchor.position.x + NODE_W + 80, y: anchor.position.y } : { x: center.x - NODE_W / 2, y: center.y - NODE_H / 2 };
  while (state.wf.nodes.some((n) => Math.abs(n.position.x - pos.x) < 40 && Math.abs(n.position.y - pos.y) < 40)) pos = { x: pos.x, y: pos.y + NODE_H + 40 };
  const params = {};
  for (const f of type.fields) params[f.name] = structuredClone(f.default);
  const node = { id: uid(), type: typeName, name, position: { x: Math.round(pos.x), y: Math.round(pos.y) }, params, continueOnFail: false };
  state.wf.nodes.push(node);
  // Liaison automatique depuis le nœud sélectionné s'il a une sortie libre
  if (anchor && state.selectedNode === anchor.id && type.inputs !== 0 && typeOf(anchor).outputs.length) {
    const used = new Set(state.wf.edges.filter((e) => e.from === anchor.id).map((e) => e.fromOutput));
    const free = typeOf(anchor).outputs.findIndex((_, idx) => !used.has(idx));
    if (free !== -1) state.wf.edges.push({ id: uid(), from: anchor.id, fromOutput: free, to: node.id });
  }
  markDirty();
  closeSidebar();
  select({ node: node.id });
  ensureVisible(node);
}
function ensureVisible(node) {
  const r = wrap.getBoundingClientRect();
  const sx = node.position.x * state.view.k + state.view.x, sy = node.position.y * state.view.k + state.view.y;
  const visibleH = isMobile() ? r.height * 0.36 : r.height;
  if (sx < 20 || sx + NODE_W * state.view.k > r.width - 20 || sy < 20 || sy + NODE_H * state.view.k > visibleH - 20) {
    state.view.x = r.width / 2 - (node.position.x + NODE_W / 2) * state.view.k;
    state.view.y = visibleH / 2 - (node.position.y + NODE_H / 2) * state.view.k;
    applyView();
  }
}
function connect(from, out, to) {
  const target = nodeById(to);
  if (!target || from === to) return false;
  if (typeOf(target).inputs === 0) { toast('Un déclencheur ne peut pas recevoir de lien', 'error'); return false; }
  if (state.wf.edges.some((e) => e.from === from && e.fromOutput === out && e.to === to)) return false;
  state.wf.edges.push({ id: uid(), from, fromOutput: out, to });
  markDirty();
  return true;
}
function setPending(p) {
  state.pending = p;
  showHint(p ? 'Touchez le nœud de destination' : null, p && 'Annuler', () => { setPending(null); renderNodes(); });
}

// ───────────── Gestes : déplacer, relier, zoomer ─────────────
let drag = null;
const pointers = new Map();
const tempEdge = svg('path', { class: 'edge temp' });

wrap.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.zoom, .hint-bar')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) };
    tempEdge.remove();
    return;
  }
  const outPort = e.target.closest('.port.out');
  const nodeEl = e.target.closest('.node');
  const edgeId = e.target.closest('.edge-hit')?.getAttribute('data-edge');
  const base = { sx: e.clientX, sy: e.clientY, moved: false };
  if (outPort) {
    drag = { ...base, type: 'connect', from: nodeEl.dataset.id, out: Number(outPort.dataset.out) };
  } else if (nodeEl) {
    const node = nodeById(nodeEl.dataset.id);
    drag = { ...base, type: 'node', id: node.id, el: nodeEl, ox: node.position.x, oy: node.position.y };
  } else if (edgeId) {
    drag = { ...base, type: 'edge', id: edgeId };
  } else {
    drag = { ...base, type: 'pan', ox: state.view.x, oy: state.view.y };
    wrap.classList.add('panning');
  }
  e.preventDefault();
  document.activeElement?.blur?.();
});

window.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) return;
  if (drag.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (drag.dist > 0) zoomAt(dist / drag.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
    drag.dist = dist;
    return;
  }
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  drag.moved = true;
  if (drag.type === 'pan') {
    state.view.x = drag.ox + dx; state.view.y = drag.oy + dy; applyView();
  } else if (drag.type === 'node') {
    const node = nodeById(drag.id);
    node.position.x = Math.round(drag.ox + dx / state.view.k);
    node.position.y = Math.round(drag.oy + dy / state.view.k);
    drag.el.style.left = `${node.position.x}px`; drag.el.style.top = `${node.position.y}px`;
    renderEdges();
  } else if (drag.type === 'connect') {
    if (!tempEdge.isConnected) edgesEl.append(tempEdge);
    tempEdge.setAttribute('d', curve(portPos(nodeById(drag.from), 'out', drag.out), toWorld(e.clientX, e.clientY)));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    nodesEl.querySelectorAll('.target-ok').forEach((n) => n.classList.remove('target-ok'));
    if (over && over.dataset.id !== drag.from) over.classList.add('target-ok');
  }
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  const d = drag;
  if (!d) return;
  if (d.type === 'pinch') { if (pointers.size === 0) drag = null; return; }
  drag = null;
  wrap.classList.remove('panning');
  tempEdge.remove();
  if (d.type === 'pan') {
    if (!d.moved) { if (state.pending) setPending(null); select(); }
  } else if (d.type === 'node') {
    if (d.moved) { markDirty(); return; }
    if (state.pending) { // 2e toucher : on termine la liaison
      const ok = connect(state.pending.from, state.pending.out, d.id);
      setPending(null);
      if (ok) toast('Nœuds reliés', 'success');
      return renderNodes();
    }
    select({ node: d.id });
  } else if (d.type === 'edge') {
    select({ edge: d.id });
  } else if (d.type === 'connect') {
    if (!d.moved) { // simple toucher sur une sortie : mode « toucher puis toucher »
      setPending({ from: d.from, out: d.out });
      return renderNodes();
    }
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    if (target) connect(d.from, d.out, target.dataset.id);
    renderNodes();
  }
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);

wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
  else { state.view.x -= e.deltaX; state.view.y -= e.deltaY; applyView(); }
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  else if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) deleteSelection();
  else if (e.key === 'Escape') { setPending(null); closeDrawer(); closeSidebar(); $('#more-menu').hidden = true; select(); }
});

// ───────────── Panneau de configuration ─────────────
function visible(field, params) {
  if (!field.showIf) return true;
  return Object.entries(field.showIf).every(([name, allowed]) => allowed.includes(params[name]));
}

function fieldControl(field, node, rerender) {
  const value = node.params[field.name] ?? field.default;
  const set = (v) => { node.params[field.name] = v; markDirty(); };
  const id = `f-${field.name}`;
  switch (field.type) {
    case 'boolean':
      return h('div', { class: 'field check' }, h('label', null,
        h('input', { type: 'checkbox', checked: Boolean(value), onchange: (e) => set(e.target.checked) }), field.label));
    case 'select':
      return h('div', { class: 'field' }, h('label', { htmlFor: id }, field.label),
        h('select', { id, onchange: (e) => { set(e.target.value); rerender(); } },
          field.options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))),
        field.help && h('div', { class: 'help' }, field.help));
    case 'keyvalue': {
      const rows = Array.isArray(value) ? value : [];
      node.params[field.name] = rows;
      const list = h('div');
      const draw = () => {
        list.replaceChildren(...rows.map((row, i) => h('div', { class: 'kv' },
          h('input', { type: 'text', value: row.key ?? '', placeholder: 'nom', 'aria-label': 'Nom', oninput: (e) => { row.key = e.target.value; markDirty(); } }),
          h('input', { type: 'text', value: row.value ?? '', placeholder: field.placeholder || 'valeur', 'aria-label': 'Valeur', oninput: (e) => { row.value = e.target.value; markDirty(); } }),
          h('button', { 'aria-label': 'Retirer', onclick: () => { rows.splice(i, 1); markDirty(); draw(); } }, '✕'))));
      };
      draw();
      return h('div', { class: 'field' }, h('div', { class: 'label' }, field.label), list,
        h('button', { class: 'link-btn', onclick: () => { rows.push({ key: '', value: '' }); markDirty(); draw(); list.lastChild.firstChild.focus(); } }, '+ Ajouter'));
    }
    case 'text':
    case 'code':
      return h('div', { class: 'field' }, h('label', { htmlFor: id }, field.label),
        h('textarea', {
          id, class: field.type === 'code' ? 'code' : '', value: value ?? '', placeholder: field.placeholder || '', spellcheck: false,
          oninput: (e) => set(e.target.value),
          onkeydown: field.type === 'code' ? (e) => {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const t = e.target, s = t.selectionStart;
            t.setRangeText('  ', s, t.selectionEnd, 'end');
            set(t.value);
          } : null,
        }),
        field.help && h('div', { class: 'help' }, field.help));
    default:
      return h('div', { class: 'field' }, h('label', { htmlFor: id }, field.label),
        h('input', {
          id, type: field.type === 'number' ? 'text' : field.type === 'password' && !String(value ?? '').includes('{{') ? 'password' : 'text',
          inputMode: field.type === 'number' ? 'decimal' : null,
          value: value ?? '', placeholder: field.placeholder || '', autocomplete: 'off', spellcheck: false,
          oninput: (e) => {
            const v = e.target.value;
            // Un champ numérique accepte aussi une expression {{ … }}
            set(field.type === 'number' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
          },
        }),
        field.help && h('div', { class: 'help' }, field.help));
  }
}

function renderPanel() {
  const panel = $('#panel');
  const node = state.wf && nodeById(state.selectedNode);
  if (!node) { panel.hidden = true; panel.replaceChildren(); return; }
  const type = typeOf(node);
  const scroll = panel.dataset.node === node.id ? panel.scrollTop : 0;
  panel.dataset.node = node.id;
  const rerender = () => renderPanel();

  const kids = [
    h('div', { class: 'panel-head' }, h('div', { class: 'node-ico' }, type.icon), h('h2', null, type.label),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => select() }, '✕')),
    h('p', { class: 'panel-desc' }, type.description),
    h('div', { class: 'field' }, h('label', { htmlFor: 'f-name' }, 'Nom du nœud'),
      h('input', { id: 'f-name', type: 'text', value: node.name, maxLength: 80, oninput: (e) => {
        node.name = e.target.value || type.label; markDirty();
        const el = nodesEl.querySelector(`[data-id="${node.id}"] .node-name`);
        if (el) el.textContent = node.name;
      } })),
  ];
  let urlBox = null;
  if (node.type === 'webhook') {
    const url = () => `${location.origin}/webhook/${String(node.params.path || '').replace(/^\/+|\/+$/g, '')}`;
    urlBox = h('div', { class: 'url-box' }, url());
    urlBox.refresh = () => { urlBox.textContent = url(); };
    kids.push(h('div', { class: 'field' }, h('div', { class: 'label' }, 'URL à appeler (workflow actif)'), urlBox));
  }
  panel.oninput = () => urlBox?.refresh();
  for (const field of type.fields) if (visible(field, node.params)) kids.push(fieldControl(field, node, rerender));

  if (type.group !== 'trigger') {
    kids.push(h('div', { class: 'field check' }, h('label', null,
      h('input', { type: 'checkbox', checked: node.continueOnFail, onchange: (e) => { node.continueOnFail = e.target.checked; markDirty(); } }),
      'Continuer le workflow même si ce nœud échoue')));
  }
  kids.push(h('div', { class: 'tip' }, 'Astuce : insérez des données avec ', h('code', null, '{{ $json.champ }}'),
    ' ou celles d’un autre nœud avec ', h('code', null, '{{ $node["Nom"].json.champ }}'), '.'));

  const rec = state.exec?.nodes?.[node.id];
  if (rec) {
    kids.push(h('div', { class: 'panel-section' }, 'Résultat', h('small', null, `${rec.inputCount} reçu(s) · ${rec.durationMs} ms`)));
    if (rec.error) kids.push(h('pre', { class: 'json error' }, rec.error));
    if (rec.status === 'skipped') kids.push(h('p', { class: 'panel-desc' }, 'Nœud ignoré : aucune donnée ne lui est parvenue.'));
    (rec.outputs || []).forEach((items, i) => {
      if (type.outputs.length > 1) kids.push(h('p', { class: 'panel-desc' }, `Sortie « ${type.outputs[i] ?? i} » — ${rec.outputCounts?.[i] ?? items.length} élément(s)`));
      kids.push(h('pre', { class: 'json' }, JSON.stringify(items, null, 2)));
    });
  }
  kids.push(h('div', { class: 'panel-actions' },
    type.group === 'trigger' && h('button', { class: 'btn primary', onclick: () => run(node.id) }, '▶ Tester ce déclencheur'),
    h('button', { class: 'btn danger', onclick: deleteSelection }, '🗑 Supprimer')));

  panel.replaceChildren(...kids);
  panel.hidden = false;
  panel.scrollTop = scroll;
}

// ───────────── Barre latérale ─────────────
function renderPalette() {
  const q = $('#node-search').value.trim().toLowerCase();
  const root = $('#palette');
  root.replaceChildren();
  for (const [group, title] of Object.entries(GROUPS)) {
    const items = Object.values(state.types).filter((t) => t.group === group
      && (!q || `${t.label} ${t.description} ${t.type}`.toLowerCase().includes(q)));
    if (!items.length) continue;
    root.append(h('div', { class: 'group-title' }, title));
    for (const t of items) {
      root.append(h('button', { class: 'palette-item', onclick: () => addNode(t.type) },
        h('span', { class: 'ico' }, t.icon), h('span', null, h('b', null, t.label), h('small', null, t.description))));
    }
  }
  if (!root.children.length) root.append(h('p', { class: 'muted' }, 'Aucun nœud ne correspond.'));
}
function renderWorkflowList() {
  const root = $('#wf-list');
  root.replaceChildren(...state.workflows.map((w) => h('button', {
    class: `wf-item${w.id === state.wf?.id ? ' current' : ''}`, onclick: () => openWorkflow(w.id),
  },
    h('span', { class: `mini-halo${w.active ? ' on' : ''}`, title: w.active ? 'Actif' : 'Inactif' }),
    h('span', { class: 'grow' }, h('b', null, w.name), h('small', null, `${w.nodeCount} nœud(s) · ${new Date(w.updatedAt).toLocaleDateString('fr-FR')}`)))));
}
async function renderTemplates() {
  const templates = await api('/templates');
  $('#tpl-list').replaceChildren(...(templates.length ? templates.map((t) => h('div', { class: 'tpl-item' },
    h('b', null, t.name), h('p', null, t.description),
    h('button', { class: 'btn small primary', onclick: () => createWorkflow(t.workflow) }, 'Utiliser ce modèle'))) : [h('p', { class: 'muted' }, 'Aucun modèle.')]));
}
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const n of ['nodes', 'workflows', 'templates']) $(`#tab-${n}`).hidden = n !== name;
}
function closeSidebar() { $('#sidebar').classList.remove('open'); }

// ───────────── Workflows ─────────────
function confirmDiscard() {
  return !state.dirty || confirm('Des modifications ne sont pas enregistrées. Continuer sans enregistrer ?');
}
async function refreshList() {
  state.workflows = await api('/workflows');
  renderWorkflowList();
}
function show(wf) {
  state.wf = wf;
  state.exec = null; state.selectedNode = null; state.selectedEdge = null; state.pending = null;
  $('#wf-name').value = wf.name;
  $('#wf-active').checked = wf.active;
  markDirty(false);
  showHint(null);
  renderNodes(); renderPanel(); renderWorkflowList(); fitView();
  localStorage.setItem('raze:last', wf.id);
}
async function openWorkflow(id, force = false) {
  if (!force && id === state.wf?.id) return closeSidebar();
  if (!force && !confirmDiscard()) return;
  show(await api(`/workflows/${id}`));
  closeSidebar();
}
async function createWorkflow(template) {
  if (!confirmDiscard()) return;
  const body = template ? { name: template.name, nodes: template.nodes, edges: template.edges } : {
    name: 'Nouveau workflow',
    nodes: [{ id: uid(), type: 'manual', name: 'Déclencheur manuel', position: { x: 80, y: 160 }, params: {} }],
    edges: [],
  };
  const wf = await api('/workflows', { method: 'POST', body });
  await refreshList();
  show(wf);
  closeSidebar();
  toast('Workflow créé', 'success');
}
async function save(silent = false) {
  if (!state.wf) return;
  state.wf.name = $('#wf-name').value.trim() || 'Sans titre';
  state.wf.active = $('#wf-active').checked;
  const saved = await api(`/workflows/${state.wf.id}`, { method: 'PUT', body: state.wf });
  state.wf.updatedAt = saved.updatedAt;
  markDirty(false);
  await refreshList();
  if (!silent) toast('Enregistré', 'success');
}
async function run(triggerNodeId) {
  if (!state.wf || state.running) return;
  if (!state.wf.nodes.length) return toast('Ajoutez d’abord un nœud', 'error');
  const btn = $('#btn-run');
  state.running = true; btn.disabled = true;
  nodesEl.querySelectorAll('.node').forEach((n) => n.classList.add('running'));
  try {
    await save(true);
    const exec = await api(`/workflows/${state.wf.id}/run`, { method: 'POST', body: { triggerNodeId: typeof triggerNodeId === 'string' ? triggerNodeId : undefined } });
    applyExecution(exec);
    if (exec.status === 'error') toast(exec.error, 'error');
    else toast(`Terminé en ${exec.durationMs} ms — touchez un nœud pour voir son résultat`, 'success');
  } catch (err) {
    toast(err.message, 'error');
    renderNodes();
  } finally {
    state.running = false; btn.disabled = false;
  }
}
function applyExecution(exec) {
  state.exec = exec;
  // En cas d'erreur, on ouvre directement le nœud fautif
  const failed = Object.entries(exec.nodes || {}).find(([, r]) => r.status === 'error')?.[0];
  if (failed && nodeById(failed)) state.selectedNode = failed;
  state.selectedEdge = null;
  renderNodes(); renderPanel();
  if (failed && nodeById(failed)) ensureVisible(nodeById(failed));
}

// ───────────── Exécutions ─────────────
async function openDrawer() {
  $('#drawer').hidden = false; $('#scrim').hidden = false;
  const list = await api(`/executions?workflowId=${encodeURIComponent(state.wf.id)}`);
  $('#exec-list').replaceChildren(...(list.length ? list.map((e) => h('button', { class: 'exec-item', onclick: () => showExecution(e.id) },
    h('span', { class: `dot ${e.status}` }),
    h('span', { class: 'grow' },
      h('b', null, `${STATUS[e.status] || e.status} · ${MODES[e.mode] || e.mode}`),
      h('small', null, `${new Date(e.startedAt).toLocaleString('fr-FR')} · ${e.durationMs} ms`),
      e.error && h('small', null, e.error)))) : [h('p', { class: 'muted' }, 'Aucune exécution pour ce workflow. Cliquez sur « Exécuter » pour lancer la première.')]));
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }
async function showExecution(id) {
  applyExecution(await api(`/executions/${id}`));
  closeDrawer();
}

// ───────────── Menu « plus » ─────────────
const actions = {
  executions: () => openDrawer(),
  export() {
    const { id, createdAt, updatedAt, active, ...data } = state.wf;
    const blob = new Blob([JSON.stringify({ ...data, name: $('#wf-name').value }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${($('#wf-name').value || 'workflow').replace(/[^\w-]+/g, '-').toLowerCase()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  import() { $('#import-file').click(); },
  async duplicate() {
    if (!confirmDiscard()) return;
    markDirty(false);
    await createWorkflow({ name: `${state.wf.name} (copie)`, nodes: state.wf.nodes, edges: state.wf.edges });
  },
  async delete() {
    if (!confirm(`Supprimer définitivement « ${state.wf.name} » et son historique ?`)) return;
    await api(`/workflows/${state.wf.id}`, { method: 'DELETE' });
    markDirty(false);
    await refreshList();
    if (state.workflows.length) await openWorkflow(state.workflows[0].id, true);
    else await createWorkflow();
    toast('Workflow supprimé');
  },
};

// ───────────── Branchements de l'interface ─────────────
const guard = (fn) => (...args) => Promise.resolve(fn(...args)).catch((err) => toast(err.message, 'error'));

$('#btn-save').addEventListener('click', guard(() => save()));
$('#btn-run').addEventListener('click', guard(() => run()));
$('#btn-executions').addEventListener('click', guard(openDrawer));
$('#btn-close-drawer').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#btn-clear-exec').addEventListener('click', guard(async () => {
  await api(`/executions?workflowId=${encodeURIComponent(state.wf.id)}`, { method: 'DELETE' });
  await openDrawer();
}));
$('#btn-new').addEventListener('click', guard(() => createWorkflow()));
$('#btn-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#btn-more').addEventListener('click', (e) => { e.stopPropagation(); $('#more-menu').hidden = !$('#more-menu').hidden; });
$('#more-menu').addEventListener('click', guard((e) => {
  const action = e.target.closest('button')?.dataset.action;
  $('#more-menu').hidden = true;
  return action && actions[action]();
}));
document.addEventListener('click', (e) => { if (!e.target.closest('#more-menu')) $('#more-menu').hidden = true; });
$('#import-file').addEventListener('change', guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error("Ce fichier n'est pas un JSON valide"); }
  if (!Array.isArray(data.nodes)) throw new Error("Ce fichier n'est pas un workflow RAZE Flow");
  await createWorkflow({ name: data.name || 'Workflow importé', nodes: data.nodes, edges: data.edges || [] });
}));
$('#wf-name').addEventListener('input', () => markDirty());
$('#wf-active').addEventListener('change', guard(async (e) => {
  await save(true);
  toast(e.target.checked ? 'Workflow activé : webhooks et planifications en service' : 'Workflow désactivé', e.target.checked ? 'success' : '');
}));
$('#node-search').addEventListener('input', renderPalette);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$('#zoom-in').addEventListener('click', () => zoomAt(1.2));
$('#zoom-out').addEventListener('click', () => zoomAt(1 / 1.2));
$('#zoom-fit').addEventListener('click', () => fitView(true));
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ───────────── Démarrage ─────────────
(async function init() {
  try {
    const types = await api('/node-types');
    for (const t of types) state.types[t.type] = t;
    renderPalette();
    renderTemplates().catch(() => {});
    await refreshList();
    const last = localStorage.getItem('raze:last');
    const first = state.workflows.find((w) => w.id === last) || state.workflows[0];
    if (first) await openWorkflow(first.id, true);
    else {
      // Premier lancement : on part du modèle de démonstration s'il existe
      const templates = await api('/templates').catch(() => []);
      await createWorkflow(templates[0]?.workflow);
    }
  } catch (err) {
    toast(`Impossible de charger RAZE Flow : ${err.message}`, 'error');
  }
})();
