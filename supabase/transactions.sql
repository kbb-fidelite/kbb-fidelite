-- ══════════════════════════════════════════════════════════════════
-- KBB TRANSACTIONS — Conservation comptable (art. L123-22 Code commerce)
-- Coller dans Supabase > SQL Editor > Run
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. TABLE transactions — immuable comptablement ──────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  date_heure      TIMESTAMPTZ NOT NULL DEFAULT now(),
  numero_commande TEXT,
  articles        JSONB,
  montant_ht      NUMERIC(10,2) NOT NULL,
  tva             NUMERIC(10,2) NOT NULL,         -- TVA 10% restauration
  montant_ttc     NUMERIC(10,2) NOT NULL,
  moyen_paiement  TEXT NOT NULL,                  -- 'carte' | 'sur_place'
  ref_stripe      TEXT,
  statut          TEXT NOT NULL DEFAULT 'valide'  -- 'valide' | 'annule'
);

-- ─── 2. SÉCURITÉ RLS ─────────────────────────────────────────────
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Lecture : anon autorisé (dashboard patron via clé anon)
CREATE POLICY "anon_transactions_select" ON transactions
  FOR SELECT TO anon USING (true);

-- Insertion : anon autorisé (app cliente insère les transactions)
CREATE POLICY "anon_transactions_insert" ON transactions
  FOR INSERT TO anon WITH CHECK (true);

-- Mise à jour : INTERDITE (aucune policy UPDATE → bloqué par défaut)
-- Suppression : INTERDITE (aucune policy DELETE → bloqué par défaut)

-- ─── 3. INDEX pour les requêtes de période ───────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_date_heure ON transactions (date_heure DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_statut     ON transactions (statut);

-- ─── 4. Commentaires de durée légale ─────────────────────────────
COMMENT ON TABLE transactions IS
  'Transactions comptables KBB — Conservation 10 ans minimum (art. L123-22 Code de commerce). INSERT uniquement, UPDATE et DELETE interdits.';

COMMENT ON COLUMN transactions.montant_ht  IS 'Montant hors taxes (TTC / 1.10)';
COMMENT ON COLUMN transactions.tva         IS 'TVA 10% restauration = TTC - HT';
COMMENT ON COLUMN transactions.montant_ttc IS 'Montant toutes taxes comprises';
