// Routeur unique des parties dynamiques du site.
//
//   /AB3K            plaque d'un commerce : redirection directe ou page de liens
//   /AB3K/a          clic « laisser un avis » depuis la page de liens
//   /AB3K/l/2        clic sur le lien numéro 2 de la page de liens
//   /api/...         interface d'administration, protégée par ADMIN_TOKEN
//
// Tout le reste est laissé aux fichiers statiques via next().

import { qrSvg } from '../lib/qr.js';

const CODE_RE = /^[A-Z0-9]{4}$/;
// Alphabet sans caractères ambigus (ni O/0, ni I/L/1) : les codes sont lus et dictés à voix haute.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_LIENS = 8;
const ROBOTS = 'noindex, nofollow';

export async function onRequest(context) {
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

  return context.next();
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

/**
 * Enregistre une visite. Volontairement sans adresse IP, sans cookie et sans
 * identifiant : la politique de confidentialité publiée s'y engage.
 * Les robots d'aperçu de lien sont ignorés pour que les bilans mensuels restent honnêtes.
 */
function compter(context, code, cible) {
  const ua = context.request.headers.get('user-agent') || '';
  if (estRobot(ua)) return;

  const maintenant = new Date();
  const jour = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(maintenant);

  const requete = context.env.DB.prepare(
    'INSERT INTO visites (code, horodatage, jour, appareil, cible) VALUES (?, ?, ?, ?, ?)',
  ).bind(code, maintenant.toISOString(), jour, familleAppareil(ua), cible);

  // La redirection ne doit pas attendre l'écriture.
  context.waitUntil(requete.run().catch(() => {}));
}

function familleAppareil(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'autre';
}

function estRobot(ua) {
  return /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slackbot|telegram|discord|curl|wget|headless|lighthouse|monitor/i.test(
    ua,
  );
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

const STYLE_PUBLIC = `
:root{--ink:#1c1f22;--ink-soft:#4a5158;--line:#dfe2e5;--accent:#2b3a4a;--accent-dark:#1c2733}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 48px;font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#fff}
main{max-width:420px;margin:0 auto}
h1{font-size:26px;line-height:1.2;margin:0 0 4px;letter-spacing:-.01em}
p.intro{color:var(--ink-soft);margin:0 0 28px}
a{color:var(--accent)}
.principal{display:block;background:var(--accent);color:#fff;text-decoration:none;font-size:18px;font-weight:600;text-align:center;padding:18px 20px;border-radius:4px;transition:background-color 120ms ease}
.principal:hover,.principal:focus-visible{background:var(--accent-dark)}
ul{list-style:none;margin:28px 0 0;padding:0;border-top:1px solid var(--line)}
li{border-bottom:1px solid var(--line)}
li a{display:block;padding:16px 4px;text-decoration:none;font-weight:600;transition:color 120ms ease}
li a:hover,li a:focus-visible{color:var(--accent-dark);text-decoration:underline}
footer{margin-top:36px;font-size:13px;color:var(--ink-soft);text-align:center}
footer a{color:var(--ink-soft)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

function pageLiens(client, liens) {
  const items = liens
    .map(
      (lien, index) =>
        `<li><a href="/${client.code}/l/${index}" rel="noopener">${echapper(lien.label)}</a></li>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="fr-CH">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${echapper(client.nom_commerce)}</title>
<meta name="robots" content="noindex">
<style>${STYLE_PUBLIC}</style>
</head>
<body>
<main>
  <h1>${echapper(client.nom_commerce)}</h1>
  <p class="intro">Merci de votre visite.</p>
  <a class="principal" href="/${client.code}/a" rel="noopener">Laisser un avis Google</a>
  ${items ? `<ul>${items}</ul>` : ''}
  <footer><a href="/">Plaque fournie par tapfacile</a></footer>
</main>
</body>
</html>`;
}

function pageInconnue() {
  return html(
    `<!DOCTYPE html>
<html lang="fr-CH">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Adresse inconnue</title>
<meta name="robots" content="noindex">
<style>${STYLE_PUBLIC}</style>
</head>
<body>
<main>
  <h1>Adresse inconnue</h1>
  <p class="intro">Cette adresse ne correspond à aucune plaque. Vérifiez le code inscrit sur le chevalet, ou cherchez le commerce directement dans Google Maps.</p>
  <footer><a href="/">tapfacile</a></footer>
</main>
</body>
</html>`,
    404,
  );
}

function pageDesactivee(client) {
  return html(
    `<!DOCTYPE html>
<html lang="fr-CH">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${echapper(client.nom_commerce)}</title>
<meta name="robots" content="noindex">
<style>${STYLE_PUBLIC}</style>
</head>
<body>
<main>
  <h1>Plaque hors service</h1>
  <p class="intro">Cette plaque n'est plus active. Si vous souhaitez laisser un avis sur ${echapper(
    client.nom_commerce,
  )}, cherchez le commerce directement dans Google Maps.</p>
  <footer><a href="/">tapfacile</a></footer>
</main>
</body>
</html>`,
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
    if (!urlValide(lien)) return { erreur: `lien invalide pour « ${label} »` };
    liens.push({ label, url: lien });
  }

  const note = String(corps.note || '').trim().slice(0, 500);

  return { nom_commerce: nom, avis_url: avis, mode, liens, note };
}

function urlValide(valeur) {
  try {
    const url = new URL(valeur);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
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
