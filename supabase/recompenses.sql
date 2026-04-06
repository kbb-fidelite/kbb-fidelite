-- ══════════════════════════════════════════════════════════════════
-- KBB — Table recompenses (programme fidélité dynamique)
-- Coller dans Supabase > SQL Editor > Run
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. TABLE recompenses ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recompenses (
  id                BIGSERIAL PRIMARY KEY,
  nom               TEXT NOT NULL,
  description       TEXT,
  points_requis     INTEGER NOT NULL DEFAULT 50,
  commande_minimum  NUMERIC(6,2) NOT NULL DEFAULT 8,
  actif             BOOLEAN NOT NULL DEFAULT true,
  ordre             INTEGER NOT NULL DEFAULT 99,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. SÉCURITÉ RLS ─────────────────────────────────────────────
ALTER TABLE recompenses ENABLE ROW LEVEL SECURITY;

-- SELECT : tout le monde peut lire les récompenses actives
CREATE POLICY "anon_recompenses_select" ON recompenses
  FOR SELECT TO anon USING (true);

-- INSERT / UPDATE / DELETE : service_role uniquement
-- (les modifications passent par l'Edge Function ou le dashboard patron)

-- ─── 3. INDEX ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_recompenses_ordre ON recompenses (ordre ASC);
CREATE INDEX IF NOT EXISTS idx_recompenses_actif ON recompenses (actif);

-- ─── 4. RÉCOMPENSES PAR DÉFAUT ───────────────────────────────────
INSERT INTO recompenses (nom, description, points_requis, commande_minimum, actif, ordre)
VALUES
  ('Boisson 33cl offerte',  'Canette ou bouteille 33cl au choix',  50,  8.00, true, 1),
  ('Dessert au choix',      'Dessert du menu au choix',            80,  10.00, true, 2),
  ('Kebab classique offert','Kebab classique (pain + garniture)',   150, 15.00, true, 3),
  ('Menu complet offert',   'Kebab + boisson + dessert au choix',  200, 20.00, true, 4)
ON CONFLICT DO NOTHING;

-- ─── 5. COLONNE reward_id DANS commandes (si pas encore présente) ─
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reward_id      BIGINT;
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reward_pts     INTEGER DEFAULT 0;
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reward_valide  BOOLEAN DEFAULT false;

COMMENT ON TABLE recompenses IS
  'Récompenses du programme fidélité KBB — gérées depuis le dashboard patron.';
COMMENT ON COLUMN recompenses.commande_minimum IS
  'Montant minimum de la commande pour activer la récompense (€)';
COMMENT ON COLUMN commandes.reward_id IS
  'ID de la récompense choisie avant paiement (null si aucune)';
COMMENT ON COLUMN commandes.reward_valide IS
  'true une fois les points déduits par validate-reward Edge Function';
