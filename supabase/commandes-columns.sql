-- ══════════════════════════════════════════════════════════════════
-- KBB — Colonnes manquantes table commandes
-- Coller dans Supabase > SQL Editor > Run
-- Sécurisé : IF NOT EXISTS, ne modifie rien si déjà présent
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE commandes ADD COLUMN IF NOT EXISTS pts_a_crediter INTEGER DEFAULT 0;
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reward_id      BIGINT;
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reward_pts     INTEGER DEFAULT 0;
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reward_valide  BOOLEAN DEFAULT false;
