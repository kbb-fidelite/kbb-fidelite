-- ══════════════════════════════════════════════════════════════════
-- KBB — Table settings (paramètres globaux de l'application)
-- Stocke notamment l'offre flash active, visible par tous les clients.
-- Coller dans Supabase > SQL Editor > Run
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS : lecture publique (clients doivent voir l'offre flash)
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_settings_select" ON settings
  FOR SELECT TO anon USING (true);

-- Écriture : anon autorisé (le patron utilise la même clé anon que l'app)
-- La sécurité repose sur le PIN patron côté client.
CREATE POLICY "anon_settings_insert" ON settings
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_settings_update" ON settings
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_settings_delete" ON settings
  FOR DELETE TO anon USING (true);

COMMENT ON TABLE settings IS
  'Paramètres globaux KBB — offre flash (key=flash), etc.';
COMMENT ON COLUMN settings.key IS
  'Clé unique du paramètre (ex: flash)';
COMMENT ON COLUMN settings.value IS
  'Valeur JSON du paramètre (ex: {msg, multi, start, end})';
