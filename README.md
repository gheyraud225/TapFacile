# tapfacile.ch

Site vitrine statique (HTML + CSS, sans framework ni build) pour tapfacile.

## Déploiement — Cloudflare Pages

1. Dans le dashboard Cloudflare, section **Pages**, créer un projet et le connecter à ce dépôt Git.
2. Configuration de build :
   - Build command : (laisser vide — aucun build)
   - Build output directory : `/`
3. Déployer. Le domaine `tapfacile.ch` est déjà rattaché au compte Cloudflare : l'associer au projet Pages dans **Custom domains**.
4. Vérifier que `tapfacile.ch` répond en HTTPS et que `www.tapfacile.ch` (si utilisé) redirige vers le domaine principal.

Le dossier ne contient volontairement aucun fichier racine à 4 caractères, pour rester compatible avec l'ajout futur d'un Cloudflare Worker gérant les redirections `/xxxx`.

## Placeholders à remplacer avant mise en ligne

Rechercher chacun des tokens suivants dans tous les fichiers et les remplacer :

| Placeholder | Où | À remplacer par |
|---|---|---|
| `NOM` | index.html, confidentialite.html, mentions.html | Votre nom |
| `ADRESSE` | mentions.html, JSON-LD (index.html) | Adresse postale complète |
| `TELEPHONE` | index.html, mentions.html, JSON-LD | Numéro de téléphone, format `+41 XX XXX XX XX` pour l'affichage et `+41XXXXXXXXX` dans les liens `tel:` |
| `EMAIL` | index.html, confidentialite.html, mentions.html, JSON-LD | Adresse e-mail sur le domaine tapfacile.ch (requise par Google pour l'accès à l'API Business Profile) |
| `FORMSPREE_ID` | index.html | Identifiant de formulaire Formspree (créer un formulaire sur formspree.io, copier l'ID dans l'URL d'action) |
| `CODE_POSTAL` | index.html (JSON-LD) | Code postal |
| `LATITUDE` / `LONGITUDE` | index.html (JSON-LD) | Coordonnées GPS du lieu d'activité |
| `LINKEDIN_URL` | index.html (section « Qui suis-je ») | Lien vers votre profil LinkedIn |
| `photo-fondateur.jpg` | fichier à ajouter à la racine, référencé dans index.html | Une photo de vous, format carré si possible. La photo est affichée en niveaux de gris (`filter: grayscale`) pour rester cohérente avec la palette du site — inutile de la désaturer vous-même. |

Commande utile pour repérer les placeholders texte :

```
grep -rn "NOM\|ADRESSE\|TELEPHONE\|EMAIL\|FORMSPREE_ID\|CODE_POSTAL\|LATITUDE\|LONGITUDE\|LINKEDIN_URL" *.html
```

## Structure

```
index.html            page principale
confidentialite.html  politique de confidentialité (LPD)
mentions.html         mentions légales
style.css             feuille de style unique
favicon.svg           favicon (carré + symbole NFC)
photo-fondateur.jpg    à ajouter (voir placeholders ci-dessus)
robots.txt
sitemap.xml

```

## QR code de démonstration

La section « Essayez le geste » contient un QR code réel (SVG généré, pas d'image externe) qui pointe vers `https://tapfacile.ch/?demo=qr` — le site lui-même. Un visiteur peut donc scanner et vivre exactement le geste qu'un client ferait avec le chevalet, sans qu'il soit nécessaire d'inventer une fausse fiche commerçant. Si vous changez de domaine, régénérez ce QR code (le SVG est un simple chemin de carrés, pas de dépendance à une lib externe).

## Notes

- Poids total visé : moins de 100 ko (hors polices, qui utilisent la police système).
- Aucune dépendance externe, aucun build, aucun outil d'analyse tiers.
- Le formulaire de contact utilise Formspree ; les liens `tel:` et `mailto:` restent l'alternative directe.
