-- ══════════════════════════════════════════════════════════════════
-- KBB SÉCURITÉ — Coller dans Supabase > SQL Editor > Run
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. ACTIVER RLS ──────────────────────────────────────────────
ALTER TABLE clients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE commandes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE parrainages ENABLE ROW LEVEL SECURITY;

-- Policies opérationnelles : l'app utilise la clé anon → accès complet
-- (le vrai contrôle d'accès se fait dans les Edge Functions)
CREATE POLICY "anon_clients_all"     ON clients     FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_commandes_all"   ON commandes   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_parrainages_all" ON parrainages FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── 2. TABLE config — PIN employés (jamais lisible via anon) ─────
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE config ENABLE ROW LEVEL SECURITY;
-- Aucune policy anon = accès interdit pour tous sauf service_role (Edge Functions)

-- PIN par défaut — CHANGER AVANT MISE EN PRODUCTION
INSERT INTO config (key, value) VALUES
  ('pin_employe',  '1234'),
  ('pin_patron',   '5678'),
  ('pin_cuisine',  '2222'),
  ('pin_comptoir', '3333')
ON CONFLICT (key) DO NOTHING;

-- ─── 3. TABLE pin_attempts — anti brute-force employés ───────────
CREATE TABLE IF NOT EXISTS pin_attempts (
  id           SERIAL PRIMARY KEY,
  identifier   TEXT UNIQUE NOT NULL,
  attempts     INT DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_attempt TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE pin_attempts ENABLE ROW LEVEL SECURITY;
-- Aucune policy anon = accès interdit (géré uniquement par service_role)

-- ─── 4. Pour mettre à jour un PIN plus tard ──────────────────────
-- UPDATE config SET value = 'NOUVEAU_PIN', updated_at = now() WHERE key = 'pin_patron';
-- UPDATE config SET value = 'NOUVEAU_PIN', updated_at = now() WHERE key = 'pin_cuisine';
-- UPDATE config SET value = 'NOUVEAU_PIN', updated_at = now() WHERE key = 'pin_comptoir';
-- UPDATE config SET value = 'NOUVEAU_PIN', updated_at = now() WHERE key = 'pin_employe';
