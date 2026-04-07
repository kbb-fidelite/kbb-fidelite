-- ══════════════════════════════════════════════════════════════════
-- KBB — Colonne stripe_session_id sur commandes
-- Coller dans Supabase > SQL Editor > Run
-- Sécurisé : IF NOT EXISTS
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE commandes ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;

-- Index unique : une session Stripe = une commande max (anti-double-création)
CREATE UNIQUE INDEX IF NOT EXISTS idx_commandes_stripe_session
  ON commandes (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
