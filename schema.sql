-- Schéma de la base D1 pour tapfacile.
-- Application : wrangler d1 execute tapfacile --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS clients (
  code          TEXT PRIMARY KEY,              -- code court à 4 caractères, jamais réattribué
  nom_commerce  TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'redirect', -- 'redirect' (direct vers les avis) ou 'page'
  avis_url      TEXT NOT NULL,                 -- lien de la page d'avis Google du commerce
  liens         TEXT NOT NULL DEFAULT '[]',    -- JSON : [{"label":"Instagram","url":"https://..."}]
  actif         INTEGER NOT NULL DEFAULT 1,
  note          TEXT,                          -- note interne, jamais affichée publiquement
  cree_le       TEXT NOT NULL,
  modifie_le    TEXT
);

-- Aucune adresse IP, aucun identifiant de session, aucun cookie : une visite ne contient
-- que la date, l'heure, la famille d'appareil et la destination atteinte.
CREATE TABLE IF NOT EXISTS visites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  horodatage  TEXT NOT NULL,                   -- ISO 8601 UTC
  jour        TEXT NOT NULL,                   -- AAAA-MM-JJ, fuseau Europe/Zurich
  appareil    TEXT NOT NULL,                   -- 'ios', 'android' ou 'autre'
  cible       TEXT NOT NULL                    -- 'avis', 'page' ou 'lien:<index>'
);

CREATE INDEX IF NOT EXISTS idx_visites_code_jour ON visites (code, jour);
CREATE INDEX IF NOT EXISTS idx_visites_jour ON visites (jour);
