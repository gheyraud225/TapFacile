# tapfacile.ch

Site vitrine + gestion des plaques NFC/QR des commerces.

- Le site vitrine est du HTML et du CSS statiques, écrits à la main, sans framework ni build.
- La partie dynamique (redirections `/XXXX`, comptage, administration) tourne sur
  Cloudflare Pages Functions avec une base D1.

## Sommaire

- [Fonctionnement des plaques](#fonctionnement-des-plaques)
- [Déploiement](#déploiement)
- [Administration](#administration)
- [Placeholders à remplacer](#placeholders-à-remplacer)
- [Développement local](#développement-local)
- [Structure](#structure)

## Fonctionnement des plaques

Chaque commerce reçoit un **code court permanent à 4 caractères**, par exemple `AB3K`.
L'adresse `https://tapfacile.ch/AB3K` est écrite sur la puce NFC et imprimée en QR code
sur le chevalet.

Le code ne change jamais — c'est ce qui permet de garder la même plaque physique pendant
des années. En revanche la destination derrière le code se modifie à tout moment depuis
l'administration : si le commerce change de fiche Google, la plaque déjà posée continue
de fonctionner.

Deux modes par commerce :

| Mode | Ce que voit le client |
|---|---|
| `redirect` (par défaut) | Redirection immédiate vers la page d'avis Google. C'est le mode le plus direct, celui décrit sur la page d'accueil. |
| `page` | Une page de liens minimale : bouton « Laisser un avis Google » en tête, puis les liens du commerce (site internet, réseaux sociaux). |

Routes servies par la Function :

```
/AB3K          plaque : redirection ou page de liens
/AB3K/a        clic « laisser un avis » depuis la page de liens
/AB3K/l/2      clic sur le lien numéro 2
/api/…         administration, protégée par ADMIN_TOKEN
```

Un code inconnu ou désactivé affiche une page d'explication, jamais une erreur brute.

### Ce qui est compté

Chaque utilisation enregistre uniquement : la date, l'heure, la famille d'appareil
(iOS / Android / autre) et la destination atteinte. **Aucune adresse IP, aucun cookie,
aucun identifiant de session** — conformément à la politique de confidentialité publiée.
Les robots d'aperçu de lien (Googlebot, WhatsApp, Slack…) sont exclus du comptage pour
que les bilans mensuels envoyés aux commerçants restent honnêtes.

## Déploiement

Tout se fait depuis le dashboard Cloudflare, sans ligne de commande et sans copie
locale du dépôt.

### 1. Créer la base D1

**dash.cloudflare.com → Storage & Databases → D1 SQL Database** (selon l'interface :
**Workers & Pages → D1**) → **Create** → nom `tapfacile`.

Copier le **Database ID** affiché sur la page de la base. Ce n'est pas un secret, juste
un identifiant.

### 2. Reporter l'identifiant dans wrangler.toml

Étape à ne pas sauter : lorsqu'un `wrangler.toml` est présent dans le dépôt, Cloudflare
Pages l'utilise et **ignore les bindings configurés dans le dashboard**. Tant que le
placeholder `D1_DATABASE_ID` y figure, la base n'est pas reliée et l'administration
renvoie une erreur.

Éditer `wrangler.toml` (directement sur GitHub) :

```toml
database_id = "identifiant-copié-à-l-étape-1"
```

### 3. Créer les tables

Sur la page de la base → onglet **Console** → coller le contenu de `schema.sql` →
**Execute**. Vérifier ensuite dans l'onglet **Tables** que `clients` et `visites`
existent.

En ligne de commande depuis une copie locale du dépôt, l'équivalent est :

```
npx wrangler d1 execute tapfacile --remote --file=./schema.sql
```

### 4. Créer le projet Pages

**Workers & Pages → Create → Pages → Connect to Git**, sélectionner ce dépôt.

- Production branch : la branche par défaut du dépôt
- Framework preset : None
- Build command : (vide, aucun build)
- Build output directory : `/`

### 5. Définir le jeton d'administration

Générer une valeur aléatoire — sous PowerShell :

```powershell
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)
```

ou, sous macOS et Linux :

```
openssl rand -base64 32
```

Puis, dans le projet Pages : **Settings → Variables and Secrets → Add**, type **Secret**
(pas « Text »), nom `ADMIN_TOKEN`, valeur générée.

Tant que `ADMIN_TOKEN` n'est pas défini, l'API d'administration refuse toutes les
requêtes (erreur 503). C'est volontaire : jamais d'administration ouverte par défaut.

### 6. Redéployer

Les bindings et les secrets ne s'appliquent qu'aux **nouveaux** déploiements :
onglet **Deployments** → dernier déploiement → **Retry deployment**.

Tester `https://<projet>.pages.dev/admin/` : le jeton doit être accepté et la liste
s'afficher, vide.

### 7. Rattacher le domaine

**Custom domains → Set up a custom domain → `tapfacile.ch`.**

Le domaine `.ch` reste chez votre registrar suisse : Cloudflare Registrar ne vend pas
de `.ch`, mais ça n'a aucune importance ici. Seule la délégation DNS compte, et elle est
déjà en place. Le message « .ch domains aren't supported yet » concerne uniquement le
transfert de la *propriété* du domaine, pas l'hébergement.

Désactiver ensuite GitHub Pages pour que les deux hébergements ne se disputent pas le
domaine : dépôt GitHub → **Settings → Pages** → retirer le custom domain et passer la
source sur **None**. Le fichier `CNAME` devient alors sans objet.

### En cas d'erreur

| Symptôme | Cause | Correction |
|---|---|---|
| `wrangler d1 create` → `Authentication error [code: 10000]` | Workers/D1 jamais activé sur le compte | Créer la base une première fois depuis le dashboard (étape 1) |
| `Unable to read SQL text file "./schema.sql"` | Commande lancée hors du dépôt, ou pas de copie locale | Passer par la console D1 (étape 3) |
| `/admin/` répond 503 | `ADMIN_TOKEN` absent | Étape 5, puis redéployer |
| `/admin/` affiche une erreur de base | `D1_DATABASE_ID` encore en placeholder | Étape 2, puis redéployer |

## Administration

Interface sur **`https://tapfacile.ch/admin/`**, pensée pour le téléphone : c'est depuis
le comptoir du commerçant que la plaque est créée et la puce NFC encodée.

Le jeton est demandé à la première ouverture puis conservé dans le navigateur.

Créer une plaque sur place :

1. Ouvrir `/admin/`, appuyer sur **Nouveau commerce**.
2. Saisir le nom et le lien de la page d'avis Google du commerce.
3. Enregistrer — le code court est attribué automatiquement.
4. Appuyer sur **Copier** pour récupérer l'adresse, et l'écrire sur la puce NFC
   avec une application comme NFC Tools.
5. **Télécharger le SVG** du QR code pour l'impression du chevalet.

Le QR code est généré à la volée par `lib/qr.js` (encodeur écrit à la main, sans
dépendance ni service externe).

### Obtenir le lien de la page d'avis d'un commerce

Sur la fiche Google du commerce : **Demander des avis** → copier le lien court, ou
construire l'adresse `https://search.google.com/local/writereview?placeid=<PLACE_ID>`.

### À ne pas faire

Ne créez pas de page qui trie les clients selon leur satisfaction avant de proposer
l'avis. Google l'interdit explicitement et fait supprimer les avis obtenus ainsi —
c'est l'argument central de la page d'accueil, autant s'y tenir dans l'outil.

## Placeholders à remplacer

| Placeholder | Où | À remplacer par |
|---|---|---|
| `NOM` | index.html, confidentialite.html, mentions.html | Votre nom |
| `ADRESSE` | mentions.html, JSON-LD (index.html) | Adresse postale complète |
| `TELEPHONE` | index.html, mentions.html, JSON-LD | Numéro, format `+41 XX XXX XX XX` à l'affichage et `+41XXXXXXXXX` dans les liens `tel:` |
| `EMAIL` | index.html, confidentialite.html, mentions.html, JSON-LD | Adresse e-mail sur le domaine tapfacile.ch (exigée par Google pour l'API Business Profile) |
| `FORMSPREE_ID` | index.html | Identifiant du formulaire Formspree |
| `CODE_POSTAL` | index.html (JSON-LD) | Code postal |
| `LATITUDE` / `LONGITUDE` | index.html (JSON-LD) | Coordonnées GPS |
| `LINKEDIN_URL` | index.html (« Qui suis-je ») | Lien vers votre profil LinkedIn |
| `D1_DATABASE_ID` | wrangler.toml | Identifiant renvoyé par `wrangler d1 create` |
| `photo-fondateur.jpg` | fichier à ajouter à la racine | Photo de vous, carrée de préférence. Affichée en niveaux de gris par le CSS : inutile de la désaturer. |

```
grep -rn "NOM\|ADRESSE\|TELEPHONE\|EMAIL\|FORMSPREE_ID\|CODE_POSTAL\|LATITUDE\|LONGITUDE\|LINKEDIN_URL" *.html
```

## Développement local

```
npm install --no-save wrangler
npx wrangler d1 execute tapfacile --local --file=./schema.sql
npx wrangler pages dev . --local --binding ADMIN_TOKEN=jeton-de-test
```

Le site est alors sur `http://localhost:8788`, l'administration sur
`http://localhost:8788/admin/`.

Note : le comptage ignore les User-Agent de robots, ce qui inclut `curl`. Pour tester
une redirection en ligne de commande, passez un User-Agent de navigateur avec `-A`.

## Structure

```
index.html            page d'accueil
confidentialite.html  politique de confidentialité (LPD)
mentions.html         mentions légales
style.css             feuille de style du site vitrine
favicon.svg           favicon (carré + symbole NFC)
admin/index.html      interface d'administration (mobile-first)
functions/[[path]].js routeur des parties dynamiques
lib/qr.js             encodeur QR (mode octet, correction M, versions 1 à 3)
schema.sql            schéma de la base D1
wrangler.toml         configuration Cloudflare
_routes.json          chemins servis en statique plutôt que par la Function
robots.txt
sitemap.xml
```

Aucun fichier à la racine ne porte un nom de 4 caractères : cet espace est réservé aux
codes courts des plaques.
