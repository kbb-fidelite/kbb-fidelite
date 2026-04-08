-- ══════════════════════════════════════════════════════════════════
-- KBB — Correction RLS table settings
-- Supprimer les policies d'écriture anon permissives.
-- Garder uniquement la lecture publique (offre flash visible par tous).
-- Les écritures passent désormais par l'Edge Function manage-flash
-- qui utilise service_role (bypass RLS) après vérification du token patron.
--
-- Coller dans Supabase > SQL Editor > Run
-- ══════════════════════════════════════════════════════════════════

-- 1. Supprimer les policies d'écriture permissives pour anon
DROP POLICY IF EXISTS "anon_settings_insert" ON settings;
DROP POLICY IF EXISTS "anon_settings_update" ON settings;
DROP POLICY IF EXISTS "anon_settings_delete" ON settings;

-- 2. S'assurer que RLS est bien activé (déjà fait, mais idempotent)
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- 3. S'assurer que la lecture publique est en place (idempotent)
DROP POLICY IF EXISTS "anon_settings_select" ON settings;
CREATE POLICY "anon_settings_select" ON settings
  FOR SELECT TO anon USING (true);

-- 4. Vérification : lister les policies actives sur settings
-- (optionnel — à exécuter séparément pour confirmer)
-- SELECT policyname, cmd, roles, qual
-- FROM pg_policies
-- WHERE tablename = 'settings';

-- Résultat attendu : 1 seule policy — anon_settings_select (SELECT uniquement)
-- Les INSERT / UPDATE / DELETE sont bloqués pour anon.
-- service_role bypass RLS nativement → manage-flash peut écrire sans policy explicite.
