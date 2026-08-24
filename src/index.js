// Routeur unique des parties dynamiques du site.
//
//   /AB3K            plaque d'un commerce : redirection directe ou page de liens
//   /AB3K/a          clic « laisser un avis » depuis la page de liens
//   /AB3K/l/2        clic sur le lien numéro 2 de la page de liens
//   /api/...         interface d'administration, protégée par ADMIN_TOKEN
//
// Les fichiers statiques de public/ sont servis avant que ce Worker ne soit appelé :
// seules les requêtes sans fichier correspondant arrivent ici.

import { qrSvg } from './qr.js';

const CODE_RE = /^[A-Z0-9]{4}$/;
// Alphabet sans caractères ambigus (ni O/0, ni I/L/1) : les codes sont lus et dictés à voix haute.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_LIENS = 8;
const ROBOTS = 'noindex, nofollow';

export default {
  async fetch(request, env, ctx) {
    // Les fonctions internes reçoivent un contexte de forme stable, indépendante
    // de la plateforme : request, env et waitUntil.
    const context = { request, env, waitUntil: (promesse) => ctx.waitUntil(promesse) };
    return routerPrincipal(context);
  },
};

async function routerPrincipal(context) {
  const { request } = context;
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] === 'api') {
    try {
      return await routerApi(context, segments.slice(1));
    } catch (erreur) {
      return json({ erreur: erreur.message || 'erreur interne' }, 500);
    }
  }

  const code = (segments[0] || '').toUpperCase();
  if (CODE_RE.test(code)) {
    try {
      return await routerPlaque(context, code, segments.slice(1));
    } catch (erreur) {
      return texte(`Erreur temporaire. Réessayez dans un instant.\n${erreur.message}`, 500);
    }
  }

  // Aucun fichier statique ne correspond et le chemin n'est ni une plaque ni l'API.
  return context.env.ASSETS.fetch(request);
}

/* ------------------------------------------------------------------ plaques */

async function routerPlaque(context, code, reste) {
  const client = await context.env.DB.prepare(
    'SELECT code, nom_commerce, mode, avis_url, liens, actif FROM clients WHERE code = ?',
  )
    .bind(code)
    .first();

  if (!client) return pageInconnue();
  if (!client.actif) return pageDesactivee(client);

  const liens = analyserLiens(client.liens);

  if (reste.length === 0) {
    if (client.mode === 'page') {
      compter(context, code, 'page');
      return html(pageLiens(client, liens));
    }
    compter(context, code, 'avis');
    return redirection(client.avis_url);
  }

  if (reste.length === 1 && reste[0] === 'a') {
    compter(context, code, 'avis');
    return redirection(client.avis_url);
  }

  if (reste.length === 2 && reste[0] === 'l') {
    const index = Number.parseInt(reste[1], 10);
    const lien = Number.isInteger(index) ? liens[index] : undefined;
    if (!lien) return pageInconnue();
    compter(context, code, `lien:${index}`);
    return redirection(lien.url);
  }

  return pageInconnue();
}

function redirection(destination) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': ROBOTS,
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// Deux minutes : assez pour absorber un rechargement, un retour en arrière ou un
// double appui, assez court pour ne pas fusionner deux vrais clients derrière le
// même wifi de commerce — les iPhone présentent des User-Agent quasi identiques,
// une fenêtre longue les confondrait et sous-compterait les visites.
const FENETRE_DEDOUBLONNAGE_S = 120;

/**
 * Enregistre une visite, sans cookie ni identifiant de session.
 *
 * Pour ne pas compter plusieurs fois la même utilisation, une empreinte est
 * calculée à partir de l'adresse IP et du User-Agent, salée avec un secret
 * renouvelé chaque jour. L'adresse IP n'est jamais enregistrée, l'empreinte est
 * irréversible et supprimée au bout de deux minutes : passé ce délai, deux
 * utilisations ne peuvent plus être reliées entre elles.
 */
function compter(context, code, cible) {
  const { request, env } = context;
  const ua = request.headers.get('user-agent') || '';

  // Seules les vraies navigations comptent.
  if (request.method !== 'GET') return;
  if (estRobot(ua)) return;
  if (estPrechargement(request)) return;

  const maintenant = new Date();
  const jour = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(maintenant);

  // La réponse ne doit pas attendre l'écriture.
  context.waitUntil(
    enregistrerVisite(env, { code, cible, ua, jour, maintenant, request }).catch(() => {}),
  );
}

async function enregistrerVisite(env, { code, cible, ua, jour, maintenant, request }) {
  const sel = await selDuJour(env.DB, jour);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const empreinte = await empreinteVisite(sel, code, cible, ip, ua);

  const expire = new Date(maintenant.getTime() + FENETRE_DEDOUBLONNAGE_S * 1000).toISOString();

  // La purge précède l'insertion : une empreinte expirée ne doit pas bloquer le
  // comptage. INSERT OR IGNORE rend la vérification atomique, sans lecture préalable.
  const resultats = await env.DB.batch([
    env.DB.prepare('DELETE FROM empreintes WHERE expire_le < ?').bind(maintenant.toISOString()),
    env.DB.prepare('INSERT OR IGNORE INTO empreintes (empreinte, expire_le) VALUES (?, ?)').bind(
      empreinte,
      expire,
    ),
  ]);

  const premiereFois = (resultats[1]?.meta?.changes ?? 0) === 1;
  if (!premiereFois) return;

  await env.DB.prepare(
    'INSERT INTO visites (code, horodatage, jour, appareil, cible) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(code, maintenant.toISOString(), jour, familleAppareil(ua), cible)
    .run();
}

async function empreinteVisite(sel, code, cible, ip, ua) {
  const donnees = new TextEncoder().encode(`${sel}|${code}|${cible}|${ip}|${ua}`);
  const condensat = await crypto.subtle.digest('SHA-256', donnees);
  return [...new Uint8Array(condensat)]
    .slice(0, 16)
    .map((octet) => octet.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sel du jour, tiré au hasard à sa première utilisation. Les sels de plus de deux
 * jours sont supprimés : les empreintes anciennes deviennent alors irrécupérables,
 * même à partir d'une sauvegarde.
 */
async function selDuJour(db, jour) {
  const existant = await db.prepare('SELECT valeur FROM sels WHERE jour = ?').bind(jour).first();
  if (existant) return existant.valeur;

  const valeur = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((octet) => octet.toString(16).padStart(2, '0'))
    .join('');

  await db.batch([
    db.prepare('INSERT OR IGNORE INTO sels (jour, valeur) VALUES (?, ?)').bind(jour, valeur),
    db.prepare("DELETE FROM sels WHERE jour < date(?, '-2 day')").bind(jour),
  ]);

  // Relecture : une requête concurrente a pu insérer son propre sel en premier.
  const relu = await db.prepare('SELECT valeur FROM sels WHERE jour = ?').bind(jour).first();
  return relu ? relu.valeur : valeur;
}

function familleAppareil(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'autre';
}

function estRobot(ua) {
  return /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slackbot|telegram|discord|curl|wget|python-requests|okhttp|headless|lighthouse|monitor|pingdom|uptime/i.test(
    ua,
  );
}

// Le navigateur annonce lui-même les chargements anticipés : ce ne sont pas des visites.
function estPrechargement(request) {
  const entetes = [
    request.headers.get('sec-purpose'),
    request.headers.get('purpose'),
    request.headers.get('x-purpose'),
    request.headers.get('x-moz'),
  ];
  return entetes.some((valeur) => valeur && /prefetch|preview|prerender/i.test(valeur));
}

function analyserLiens(brut) {
  try {
    const valeur = JSON.parse(brut || '[]');
    return Array.isArray(valeur) ? valeur : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------- pages du visiteur */

// Feuille de style des pages vues par le client final. Elle est intégrée à la page
// pour qu'un scan aboutisse en une seule requête, sans fichier CSS à charger.
const STYLE_PUBLIC = `
:root{
  --fond:#ffffff;--fond-doux:#f6f7f7;--encre:#1c1f22;--encre-douce:#5a6169;
  --trait:#e4e7e9;--accent:#2b3a4a;--accent-vif:#1c2733;--sur-accent:#ffffff;--rayon:4px;
}
@media (prefers-color-scheme:dark){
  :root{
    --fond:#15181b;--fond-doux:#1c2024;--encre:#e9ebed;--encre-douce:#a2a9b0;
    --trait:#2b3137;--accent:#4a6480;--accent-vif:#5c7896;--sur-accent:#ffffff;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100vh;display:flex;flex-direction:column;
  padding:calc(44px + env(safe-area-inset-top)) 20px calc(28px + env(safe-area-inset-bottom));
  font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  color:var(--encre);background:var(--fond);
  -webkit-font-smoothing:antialiased;
}
main{width:100%;max-width:400px;margin:0 auto;flex:1}
svg{display:block}

.monogramme{
  width:56px;height:56px;border-radius:var(--rayon);background:var(--accent);
  color:var(--sur-accent);display:flex;align-items:center;justify-content:center;
  font-size:21px;font-weight:600;letter-spacing:.03em;margin:0 0 22px;
}
h1{font-size:27px;line-height:1.2;font-weight:700;margin:0 0 6px;letter-spacing:-.015em;overflow-wrap:anywhere}
.intro{color:var(--encre-douce);margin:0 0 26px;font-size:16px}

.principal{
  display:flex;align-items:center;justify-content:center;gap:10px;width:100%;
  min-height:56px;padding:16px 20px;background:var(--accent);color:var(--sur-accent);
  text-decoration:none;font-size:17px;font-weight:600;border-radius:var(--rayon);
  transition:background-color 140ms ease;
}
.principal:hover,.principal:focus-visible,.principal:active{background:var(--accent-vif)}
.principal svg{width:19px;height:19px;flex:none}

.etiquette{
  display:flex;align-items:center;gap:12px;margin:34px 0 2px;
  font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--encre-douce);
}
.etiquette::after{content:"";flex:1;height:1px;background:var(--trait)}

ul{list-style:none;margin:0;padding:0}
li+li{border-top:1px solid var(--trait)}
li a{
  display:flex;align-items:center;gap:14px;min-height:58px;padding:14px 2px;
  color:var(--encre);text-decoration:none;font-weight:500;
  transition:color 140ms ease;
}
li a:hover,li a:focus-visible{color:var(--accent)}
.icone{flex:none;width:22px;height:22px;color:var(--encre-douce);transition:color 140ms ease}
li a:hover .icone,li a:focus-visible .icone{color:var(--accent)}
.libelle{flex:1;min-width:0;overflow-wrap:anywhere}
.chevron{flex:none;width:15px;height:15px;color:var(--encre-douce)}

footer{margin-top:36px;padding-top:20px;border-top:1px solid var(--trait);text-align:center}
footer a{color:var(--encre-douce);font-size:13px;text-decoration:none;transition:color 140ms ease}
footer a:hover,footer a:focus-visible{color:var(--encre)}

a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}

@media (prefers-reduced-motion:no-preference){
  @keyframes apparition{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  main>*{animation:apparition 420ms cubic-bezier(.2,.6,.3,1) both}
  main>*:nth-child(2){animation-delay:50ms}
  main>*:nth-child(3){animation-delay:90ms}
  main>*:nth-child(4){animation-delay:130ms}
  main>*:nth-child(5){animation-delay:180ms}
  main>*:nth-child(6){animation-delay:210ms}
}
`;

// Pictogrammes au trait, dans le même registre que ceux du site vitrine.
// Aucun logo de marque n'est reproduit : ce sont des formes simplifiées.
const PICTOS = {
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.1"/>',
  facebook: '<rect x="3" y="3" width="18" height="18" rx="4.5"/><path d="M15 8h-1.3c-.9 0-1.7.8-1.7 1.7V19"/><path d="M10 12.5h4.5"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="4.5"/><path d="M7.6 10.5V17"/><circle cx="7.6" cy="7.4" r="1"/><path d="M11.4 17v-6.5"/><path d="M11.4 13.4a2.6 2.6 0 0 1 5.2 0V17"/>',
  youtube: '<rect x="2.5" y="5.8" width="19" height="12.4" rx="3.6"/><path d="M10.4 9.4l5 2.6-5 2.6z"/>',
  tiktok: '<path d="M9.6 11.4a3.9 3.9 0 1 0 3.9 3.9V3.4c.7 2.1 2.4 3.5 4.6 3.7"/>',
  x: '<path d="M4.4 4.4l15.2 15.2"/><path d="M19.6 4.4L4.4 19.6"/>',
  whatsapp: '<path d="M20.4 11.8a8.4 8.4 0 0 1-12.4 7.4L3.6 20.4l1.3-4.3a8.4 8.4 0 1 1 15.5-4.3z"/><path d="M9.2 9.6c.4 1.6 1.8 3.4 3.6 4.2"/>',
  maps: '<path d="M12 21.2s7.1-6.5 7.1-11.2a7.1 7.1 0 0 0-14.2 0c0 4.7 7.1 11.2 7.1 11.2z"/><circle cx="12" cy="10" r="2.6"/>',
  site: '<circle cx="12" cy="12" r="9"/><path d="M3.2 12h17.6"/><path d="M12 3a13.6 13.6 0 0 1 0 18a13.6 13.6 0 0 1 0-18z"/>',
  telephone: '<path d="M6.4 3.5h3l1.5 3.7-2 1.4a11 11 0 0 0 5.5 5.5l1.4-2 3.7 1.5v3a1.9 1.9 0 0 1-2.1 1.9A15.6 15.6 0 0 1 4.5 5.6a1.9 1.9 0 0 1 1.9-2.1z"/>',
  courriel: '<rect x="2.8" y="5" width="18.4" height="14" rx="2.4"/><path d="M3.4 7.2l8.6 6 8.6-6"/>',
  crayon: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>',
  chevron: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
};

function picto(nom, classe) {
  return (
    `<svg class="${classe}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PICTOS[nom]}</svg>`
  );
}

// Choisit le pictogramme d'un lien d'après son domaine. Le libellé saisi par
// l'administrateur n'est jamais interprété : seule l'URL décide.
function pictoDuLien(url) {
  let hote = '';
  try {
    const analysee = new URL(url);
    if (analysee.protocol === 'tel:') return 'telephone';
    if (analysee.protocol === 'mailto:') return 'courriel';
    hote = analysee.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'site';
  }
  const correspondances = [
    [/(^|\.)instagram\.com$/, 'instagram'],
    [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook'],
    [/(^|\.)linkedin\.com$/, 'linkedin'],
    [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
    [/(^|\.)tiktok\.com$/, 'tiktok'],
    [/(^|\.)(twitter\.com|x\.com)$/, 'x'],
    [/(^|\.)(wa\.me|whatsapp\.com)$/, 'whatsapp'],
    [/(^|\.)(google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)$/, 'maps'],
  ];
  for (const [motif, nom] of correspondances) if (motif.test(hote)) return nom;
  return 'site';
}

// Deux initiales au maximum, en ignorant les articles courants.
function initiales(nom) {
  const ignores = new Set(['le', 'la', 'les', 'l', 'du', 'de', 'des', 'd', 'au', 'aux', 'chez']);
  const mots = String(nom)
    .split(/[\s'’\-_.]+/)
    .filter(Boolean);
  const utiles = mots.filter((mot) => !ignores.has(mot.toLowerCase()));
  const source = utiles.length ? utiles : mots;
  const lettres = source.slice(0, 2).map((mot) => Array.from(mot)[0] || '').join('');
  return (lettres || '?').toUpperCase();
}

function enveloppe({ titre, contenu, themeClair = '#ffffff', themeSombre = '#15181b' }) {
  return `<!DOCTYPE html>
<html lang="fr-CH">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${echapper(titre)}</title>
<meta name="robots" content="noindex">
<meta name="theme-color" media="(prefers-color-scheme:light)" content="${themeClair}">
<meta name="theme-color" media="(prefers-color-scheme:dark)" content="${themeSombre}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE_PUBLIC}</style>
</head>
<body>
<main>
${contenu}
</main>
</body>
</html>`;
}

function pied(texte) {
  return `  <footer><a href="/">${texte}</a></footer>`;
}

function pageLiens(client, liens) {
  const items = liens
    .map((lien, index) => {
      return (
        `<li><a href="/${client.code}/l/${index}" rel="noopener">` +
        picto(pictoDuLien(lien.url), 'icone') +
        `<span class="libelle">${echapper(lien.label)}</span>` +
        picto('chevron', 'chevron') +
        `</a></li>`
      );
    })
    .join('');

  const bloquLiens = items
    ? `  <p class="etiquette">Retrouvez-nous</p>\n  <ul>${items}</ul>`
    : '';

  return enveloppe({
    titre: client.nom_commerce,
    contenu: [
      `  <div class="monogramme" aria-hidden="true">${echapper(initiales(client.nom_commerce))}</div>`,
      `  <h1>${echapper(client.nom_commerce)}</h1>`,
      `  <p class="intro">Merci de votre visite.</p>`,
      `  <a class="principal" href="/${client.code}/a" rel="noopener">${picto('crayon', '')}Laisser un avis Google</a>`,
      bloquLiens,
      pied('Plaque fournie par tapfacile'),
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

function pageInconnue() {
  return html(
    enveloppe({
      titre: 'Adresse inconnue',
      contenu: [
        `  <h1>Adresse inconnue</h1>`,
        `  <p class="intro">Cette adresse ne correspond à aucune plaque. Vérifiez le code inscrit sur le chevalet, ou cherchez le commerce directement dans Google Maps.</p>`,
        pied('tapfacile'),
      ].join('\n'),
    }),
    404,
  );
}

function pageDesactivee(client) {
  return html(
    enveloppe({
      titre: client.nom_commerce,
      contenu: [
        `  <h1>Plaque hors service</h1>`,
        `  <p class="intro">Cette plaque n'est plus active. Si vous souhaitez laisser un avis sur ${echapper(
          client.nom_commerce,
        )}, cherchez le commerce directement dans Google Maps.</p>`,
        pied('tapfacile'),
      ].join('\n'),
    }),
    410,
  );
}

/* --------------------------------------------------------- administration */

async function routerApi(context, segments) {
  const { request, env } = context;

  const controle = await verifierJeton(request, env);
  if (!controle.ok) return json({ erreur: controle.message }, controle.status);

  // /api/clients
  if (segments[0] === 'clients' && segments.length === 1) {
    if (request.method === 'GET') return listerClients(env);
    if (request.method === 'POST') return creerClient(context);
    return json({ erreur: 'méthode non autorisée' }, 405);
  }

  // /api/clients/AB3K[...]
  if (segments[0] === 'clients' && segments.length >= 2) {
    const code = segments[1].toUpperCase();
    if (!CODE_RE.test(code)) return json({ erreur: 'code invalide' }, 400);

    if (segments.length === 2) {
      if (request.method === 'GET') return detailClient(env, code);
      if (request.method === 'PUT') return modifierClient(context, code);
      return json({ erreur: 'méthode non autorisée' }, 405);
    }

    if (segments.length === 3 && segments[2] === 'qr.svg' && request.method === 'GET') {
      const origine = new URL(request.url).origin;
      return new Response(qrSvg(`${origine}/${code}`), {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-Robots-Tag': ROBOTS,
        },
      });
    }
  }

  return json({ erreur: 'route inconnue' }, 404);
}

async function verifierJeton(request, env) {
  if (!env.ADMIN_TOKEN) {
    return {
      ok: false,
      status: 503,
      message:
        "ADMIN_TOKEN n'est pas configuré. Exécutez : wrangler pages secret put ADMIN_TOKEN",
    };
  }
  const entete = request.headers.get('authorization') || '';
  const fourni = entete.startsWith('Bearer ') ? entete.slice(7) : '';
  if (!(await jetonsEgaux(fourni, env.ADMIN_TOKEN))) {
    return { ok: false, status: 401, message: 'non autorisé' };
  }
  return { ok: true };
}

// Comparaison à temps constant : on compare les empreintes, de longueur toujours identique.
async function jetonsEgaux(a, b) {
  const encodeur = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encodeur.encode(a)),
    crypto.subtle.digest('SHA-256', encodeur.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let ecart = 0;
  for (let i = 0; i < va.length; i++) ecart |= va[i] ^ vb[i];
  return ecart === 0;
}

async function listerClients(env) {
  const { results } = await env.DB.prepare(
    `SELECT c.code, c.nom_commerce, c.mode, c.actif, c.cree_le,
            (SELECT COUNT(*) FROM visites v WHERE v.code = c.code) AS total,
            (SELECT COUNT(*) FROM visites v WHERE v.code = c.code AND v.jour >= date('now', '-30 day')) AS trente_jours
     FROM clients c
     ORDER BY c.actif DESC, c.nom_commerce COLLATE NOCASE`,
  ).all();
  return json({ clients: results || [] });
}

async function detailClient(env, code) {
  const client = await env.DB.prepare('SELECT * FROM clients WHERE code = ?').bind(code).first();
  if (!client) return json({ erreur: 'code introuvable' }, 404);

  const [parMois, parAppareil, parCible, totaux] = await Promise.all([
    env.DB.prepare(
      `SELECT substr(jour, 1, 7) AS mois, COUNT(*) AS n FROM visites
       WHERE code = ? GROUP BY mois ORDER BY mois DESC LIMIT 12`,
    )
      .bind(code)
      .all(),
    env.DB.prepare(
      'SELECT appareil, COUNT(*) AS n FROM visites WHERE code = ? GROUP BY appareil',
    )
      .bind(code)
      .all(),
    env.DB.prepare('SELECT cible, COUNT(*) AS n FROM visites WHERE code = ? GROUP BY cible')
      .bind(code)
      .all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN jour >= date('now', '-30 day') THEN 1 ELSE 0 END) AS trente_jours,
              SUM(CASE WHEN jour >= date('now', '-7 day') THEN 1 ELSE 0 END) AS sept_jours
       FROM visites WHERE code = ?`,
    )
      .bind(code)
      .first(),
  ]);

  return json({
    client: { ...client, liens: analyserLiens(client.liens) },
    statistiques: {
      total: totaux?.total || 0,
      trente_jours: totaux?.trente_jours || 0,
      sept_jours: totaux?.sept_jours || 0,
      par_mois: parMois.results || [],
      par_appareil: parAppareil.results || [],
      par_cible: parCible.results || [],
    },
  });
}

async function creerClient(context) {
  const corps = await lireJson(context.request);
  const champs = validerChamps(corps);
  if (champs.erreur) return json({ erreur: champs.erreur }, 400);

  const code = await genererCode(context.env.DB);
  const maintenant = new Date().toISOString();

  await context.env.DB.prepare(
    `INSERT INTO clients (code, nom_commerce, mode, avis_url, liens, actif, note, cree_le, modifie_le)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(
      code,
      champs.nom_commerce,
      champs.mode,
      champs.avis_url,
      JSON.stringify(champs.liens),
      champs.note,
      maintenant,
      maintenant,
    )
    .run();

  return json({ code }, 201);
}

async function modifierClient(context, code) {
  const existant = await context.env.DB.prepare('SELECT code FROM clients WHERE code = ?')
    .bind(code)
    .first();
  if (!existant) return json({ erreur: 'code introuvable' }, 404);

  const corps = await lireJson(context.request);
  const champs = validerChamps(corps);
  if (champs.erreur) return json({ erreur: champs.erreur }, 400);

  await context.env.DB.prepare(
    `UPDATE clients SET nom_commerce = ?, mode = ?, avis_url = ?, liens = ?, actif = ?, note = ?, modifie_le = ?
     WHERE code = ?`,
  )
    .bind(
      champs.nom_commerce,
      champs.mode,
      champs.avis_url,
      JSON.stringify(champs.liens),
      corps.actif === false ? 0 : 1,
      champs.note,
      new Date().toISOString(),
      code,
    )
    .run();

  return json({ code });
}

function validerChamps(corps) {
  if (!corps || typeof corps !== 'object') return { erreur: 'corps de requête invalide' };

  const nom = String(corps.nom_commerce || '').trim();
  if (!nom) return { erreur: 'le nom du commerce est obligatoire' };
  if (nom.length > 120) return { erreur: 'nom du commerce trop long (120 caractères maximum)' };

  const avis = String(corps.avis_url || '').trim();
  if (!urlValide(avis)) return { erreur: "le lien de la page d'avis doit être une URL http(s) valide" };

  const mode = corps.mode === 'page' ? 'page' : 'redirect';

  const liensBruts = Array.isArray(corps.liens) ? corps.liens : [];
  if (liensBruts.length > MAX_LIENS) return { erreur: `${MAX_LIENS} liens au maximum` };

  const liens = [];
  for (const brut of liensBruts) {
    const label = String(brut?.label || '').trim();
    const lien = String(brut?.url || '').trim();
    if (!label && !lien) continue;
    if (!label) return { erreur: 'chaque lien doit porter un intitulé' };
    if (label.length > 60) return { erreur: 'intitulé de lien trop long (60 caractères maximum)' };
    if (!lienValide(lien)) {
      return { erreur: `lien invalide pour « ${label} » : attendu https://…, tel:… ou mailto:…` };
    }
    liens.push({ label, url: lien });
  }

  const note = String(corps.note || '').trim().slice(0, 500);

  return { nom_commerce: nom, avis_url: avis, mode, liens, note };
}

// La destination des avis reste strictement une page web.
function urlValide(valeur) {
  try {
    const url = new URL(valeur);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// Les liens du commerce acceptent en plus le téléphone et le courriel, très
// utiles sur un mobile. Toute autre famille de schéma reste refusée.
function lienValide(valeur) {
  let url;
  try {
    url = new URL(valeur);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return true;
  if (url.protocol === 'tel:') return /^[+0-9 ().-]{4,25}$/.test(decodeURIComponent(url.pathname));
  if (url.protocol === 'mailto:') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(decodeURIComponent(url.pathname));
  return false;
}

async function genererCode(db) {
  for (let essai = 0; essai < 25; essai++) {
    const octets = crypto.getRandomValues(new Uint8Array(8));
    let code = '';
    for (const octet of octets) {
      if (code.length === 4) break;
      // Rejet des valeurs qui biaiseraient le tirage (248 = 8 × 31).
      if (octet >= 248) continue;
      code += ALPHABET[octet % ALPHABET.length];
    }
    if (code.length < 4) continue;

    const occupe = await db.prepare('SELECT code FROM clients WHERE code = ?').bind(code).first();
    if (!occupe) return code;
  }
  throw new Error('impossible de générer un code libre');
}

/* ------------------------------------------------------------------ outils */

async function lireJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(donnees, status = 200) {
  return new Response(JSON.stringify(donnees), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': ROBOTS,
    },
  });
}

function html(contenu, status = 200) {
  return new Response(contenu, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': ROBOTS,
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function texte(contenu, status = 200) {
  return new Response(contenu, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function echapper(valeur) {
  return String(valeur).replace(/[<>&"']/g, (caractere) => {
    switch (caractere) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
