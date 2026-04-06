-- ══════════════════════════════════════════════════════════════════
-- KBB FACTURES — Table de facturation client (art. 289 CGI)
-- Coller dans Supabase > SQL Editor > Run
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. TABLE factures ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS factures (
  id              BIGSERIAL PRIMARY KEY,
  numero_facture  TEXT NOT NULL UNIQUE,          -- FAC-2025-00001
  date            TIMESTAMPTZ NOT NULL DEFAULT now(),
  commande_id     TEXT,                          -- référence commande
  client_prenom   TEXT,
  total_ht_10     NUMERIC(10,2) NOT NULL DEFAULT 0,  -- HT soumis à 10%
  tva_10          NUMERIC(10,2) NOT NULL DEFAULT 0,  -- TVA 10%
  total_ht_55     NUMERIC(10,2) NOT NULL DEFAULT 0,  -- HT soumis à 5,5%
  tva_55          NUMERIC(10,2) NOT NULL DEFAULT 0,  -- TVA 5,5%
  total_ttc       NUMERIC(10,2) NOT NULL,
  moyen_paiement  TEXT NOT NULL DEFAULT 'inconnu',   -- 'carte' | 'sur_place'
  ref_stripe      TEXT,
  articles        JSONB                              -- [{name,qty,price,cat,tva_rate}]
);

-- ─── 2. SÉCURITÉ RLS ─────────────────────────────────────────────
ALTER TABLE factures ENABLE ROW LEVEL SECURITY;

-- SELECT : anon autorisé (dashboard patron + téléchargement client)
CREATE POLICY "anon_factures_select" ON factures
  FOR SELECT TO anon USING (true);

-- INSERT : anon autorisé (app cliente crée les factures)
CREATE POLICY "anon_factures_insert" ON factures
  FOR INSERT TO anon WITH CHECK (true);

-- UPDATE : INTERDIT (aucune policy → bloqué par RLS)
-- DELETE : INTERDIT (aucune policy → bloqué par RLS)

-- ─── 3. INDEX ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_factures_date           ON factures (date DESC);
CREATE INDEX IF NOT EXISTS idx_factures_numero_facture ON factures (numero_facture);
CREATE INDEX IF NOT EXISTS idx_factures_commande_id    ON factures (commande_id);

-- ─── 4. Métadonnées légales ───────────────────────────────────────
COMMENT ON TABLE factures IS
  'Factures clients KBB — Conservation 10 ans minimum (art. 289 CGI, L123-22 Code de commerce). INSERT uniquement, UPDATE et DELETE interdits par RLS. Deux taux de TVA : 10% (plats chauds) et 5,5% (desserts froids).';

COMMENT ON COLUMN factures.total_ht_10 IS 'Base HT soumise à TVA 10% (plats chauds : kebabs, tacos, salades, menus)';
COMMENT ON COLUMN factures.tva_10      IS 'TVA 10% = total_ht_10 × 0,10';
COMMENT ON COLUMN factures.total_ht_55 IS 'Base HT soumise à TVA 5,5% (desserts froids)';
COMMENT ON COLUMN factures.tva_55      IS 'TVA 5,5% = total_ht_55 × 0,055';
COMMENT ON COLUMN factures.articles    IS 'Détail articles JSON : [{name, qty, price, cat, tva_rate}]';
