'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { exec } = require('node:child_process');
const { perItem, httpJson } = require('./helpers');

function safeFilePath(name) {
  const { FILES_DIR } = require('../store');
  const target = path.resolve(FILES_DIR, String(name || ''));
  if (!name || (target !== FILES_DIR && !target.startsWith(FILES_DIR + path.sep))) {
    throw new Error('Nom de fichier invalide (les fichiers restent dans data/files)');
  }
  return target;
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
};

module.exports = [
  {
    type: 'ai', label: 'IA (chat)', group: 'integration', icon: '🤖',
    description: 'Interroge un modèle IA compatible OpenAI : Ollama (gratuit, local), OpenRouter, Groq, OpenAI…',
    outputs: ['sortie'],
    fields: [
      { name: 'baseUrl', label: "URL de l'API", type: 'string', default: 'http://localhost:11434/v1', help: 'Ollama : http://localhost:11434/v1 — OpenRouter : https://openrouter.ai/api/v1' },
      { name: 'apiKey', label: 'Clé API', type: 'password', default: '', placeholder: '{{ $env.OPENAI_API_KEY }}', help: 'Laisser vide pour Ollama' },
      { name: 'model', label: 'Modèle', type: 'string', default: 'llama3.2' },
      { name: 'system', label: 'Instructions système', type: 'text', default: '' },
      { name: 'prompt', label: 'Message', type: 'text', default: '', placeholder: 'Résume ce texte : {{ $json.texte }}' },
      { name: 'temperature', label: 'Température', type: 'number', default: 0.7 },
    ],
    run: perItem(async (item, p) => {
      const messages = [];
      if (p.system) messages.push({ role: 'system', content: String(p.system) });
      messages.push({ role: 'user', content: String(p.prompt) });
      const data = await httpJson(`${String(p.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
        body: { model: p.model, messages, temperature: Number(p.temperature) },
        timeout: 120,
      });
      return { ...item, reponse: data?.choices?.[0]?.message?.content ?? '', modele: data?.model, usage: data?.usage };
    }),
  },
  {
    type: 'telegram', label: 'Telegram', group: 'integration', icon: '✈️',
    description: 'Envoie un message avec un bot Telegram.',
    outputs: ['sortie'],
    fields: [
      { name: 'token', label: 'Jeton du bot', type: 'password', default: '', placeholder: '{{ $env.TELEGRAM_TOKEN }}' },
      { name: 'chatId', label: 'ID du chat', type: 'string', default: '' },
      { name: 'text', label: 'Message', type: 'text', default: '' },
    ],
    run: perItem(async (item, p) => {
      const data = await httpJson(`https://api.telegram.org/bot${p.token}/sendMessage`, { body: { chat_id: p.chatId, text: String(p.text) } });
      return { ...item, telegram: { ok: data.ok, messageId: data.result?.message_id } };
    }),
  },
  {
    type: 'discord', label: 'Discord', group: 'integration', icon: '🎮',
    description: 'Envoie un message dans un salon Discord via un webhook.',
    outputs: ['sortie'],
    fields: [
      { name: 'webhookUrl', label: 'URL du webhook Discord', type: 'password', default: '' },
      { name: 'content', label: 'Message', type: 'text', default: '' },
      { name: 'username', label: "Nom affiché (optionnel)", type: 'string', default: '' },
    ],
    run: perItem(async (item, p) => {
      await httpJson(p.webhookUrl, { body: { content: String(p.content).slice(0, 2000), username: p.username || undefined } });
      return { ...item, discord: { envoye: true } };
    }),
  },
  {
    type: 'slack', label: 'Slack', group: 'integration', icon: '💬',
    description: 'Envoie un message Slack via un webhook entrant.',
    outputs: ['sortie'],
    fields: [
      { name: 'webhookUrl', label: 'URL du webhook Slack', type: 'password', default: '' },
      { name: 'text', label: 'Message', type: 'text', default: '' },
    ],
    run: perItem(async (item, p) => {
      await httpJson(p.webhookUrl, { body: { text: String(p.text) } });
      return { ...item, slack: { envoye: true } };
    }),
  },
  {
    type: 'email', label: 'Envoyer un e-mail', group: 'integration', icon: '📧',
    description: 'Envoie un e-mail via un serveur SMTP (Gmail, Brevo, Mailgun…).',
    outputs: ['sortie'],
    fields: [
      { name: 'host', label: 'Serveur SMTP', type: 'string', default: 'smtp.gmail.com' },
      { name: 'port', label: 'Port', type: 'number', default: 465 },
      { name: 'secure', label: 'Connexion sécurisée SSL (port 465)', type: 'boolean', default: true },
      { name: 'user', label: 'Utilisateur', type: 'string', default: '' },
      { name: 'pass', label: 'Mot de passe', type: 'password', default: '', placeholder: '{{ $env.SMTP_PASS }}' },
      { name: 'from', label: 'Expéditeur', type: 'string', default: '' },
      { name: 'to', label: 'Destinataire(s)', type: 'string', default: '' },
      { name: 'subject', label: 'Objet', type: 'string', default: '' },
      { name: 'text', label: 'Message (texte)', type: 'text', default: '' },
      { name: 'html', label: 'Message (HTML, optionnel)', type: 'text', default: '' },
    ],
    run: perItem(async (item, p) => {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport({
        host: p.host, port: Number(p.port), secure: Boolean(p.secure),
        auth: p.user ? { user: p.user, pass: p.pass } : undefined,
      });
      const info = await transport.sendMail({ from: p.from || p.user, to: p.to, subject: p.subject, text: p.text || undefined, html: p.html || undefined });
      return { ...item, email: { messageId: info.messageId, accepted: info.accepted } };
    }),
  },
  {
    type: 'rss', label: 'Lire un flux RSS', group: 'integration', icon: '📰',
    description: "Récupère les articles d'un flux RSS ou Atom.",
    outputs: ['sortie'],
    fields: [{ name: 'url', label: 'URL du flux', type: 'string', default: '' }],
    run: perItem(async (item, p) => {
      const res = await fetch(p.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const entries = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
      return entries.map((e) => ({
        titre: tag(e, 'title'),
        lien: tag(e, 'link') || (e.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? ''),
        date: tag(e, 'pubDate') || tag(e, 'updated') || tag(e, 'published'),
        resume: (tag(e, 'description') || tag(e, 'summary')).replace(/<[^>]+>/g, '').slice(0, 500),
      }));
    }),
  },
  {
    type: 'readFile', label: 'Lire un fichier', group: 'integration', icon: '📄',
    description: 'Lit un fichier texte ou JSON du dossier data/files.',
    outputs: ['sortie'],
    fields: [{ name: 'name', label: 'Nom du fichier', type: 'string', default: 'donnees.json' }],
    run: perItem(async (item, p) => {
      const content = await fs.readFile(safeFilePath(p.name), 'utf8');
      let data = content;
      if (String(p.name).endsWith('.json')) { try { data = JSON.parse(content); } catch { /* texte */ } }
      return { ...item, fichier: p.name, contenu: data };
    }),
  },
  {
    type: 'writeFile', label: 'Écrire un fichier', group: 'integration', icon: '💾',
    description: 'Écrit (ou complète) un fichier dans le dossier data/files.',
    outputs: ['sortie'],
    fields: [
      { name: 'name', label: 'Nom du fichier', type: 'string', default: 'sortie.txt' },
      { name: 'content', label: 'Contenu', type: 'text', default: '{{ $json }}' },
      { name: 'append', label: 'Ajouter à la fin au lieu de remplacer', type: 'boolean', default: false },
    ],
    run: perItem(async (item, p) => {
      const target = safeFilePath(p.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const content = typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2);
      if (p.append) await fs.appendFile(target, content + '\n');
      else await fs.writeFile(target, content);
      return { ...item, fichier: p.name, octets: Buffer.byteLength(content) };
    }),
  },
  {
    type: 'exec', label: 'Commande système', group: 'integration', icon: '⚙️',
    description: 'Exécute une commande sur le serveur. Désactivé par défaut (RAZE_ALLOW_EXEC=true pour activer).',
    outputs: ['sortie'],
    fields: [{ name: 'command', label: 'Commande', type: 'string', default: 'echo "bonjour"' }],
    run: perItem((item, p) => new Promise((resolve, reject) => {
      if (process.env.RAZE_ALLOW_EXEC !== 'true') {
        return reject(new Error('Nœud désactivé : définissez RAZE_ALLOW_EXEC=true pour autoriser les commandes système'));
      }
      exec(String(p.command), { timeout: 60000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error('Commande interrompue (délai de 60 s dépassé)'));
        resolve({ ...item, code: err ? err.code ?? 1 : 0, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    })),
  },
];
