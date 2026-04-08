-- ══════════════════════════════════════════════════════════════════
-- KBB — Correction RLS priorités 1 et 2
-- P1 : Supprimer DELETE anon sur clients, commandes, parrainages
-- P2 : Supprimer UPDATE + DELETE anon sur parrainages
--
-- Coller dans Supabase > SQL Editor > Run
-- ══════════════════════════════════════════════════════════════════

-- ── TABLE clients ────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_clients_all"    ON clients;
DROP POLICY IF EXISTS "anon_clients_select" ON clients;
DROP POLICY IF EXISTS "anon_clients_insert" ON clients;
DROP POLICY IF EXISTS "anon_clients_update" ON clients;

CREATE POLICY "anon_clients_select" ON clients
  FOR SELECT TO anon USING (true);

CREATE POLICY "anon_clients_insert" ON clients
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_clients_update" ON clients
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- DELETE : aucune policy → bloqué par RLS pour anon


-- ── TABLE commandes ──────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_commandes_all"    ON commandes;
DROP POLICY IF EXISTS "anon_commandes_select" ON commandes;
DROP POLICY IF EXISTS "anon_commandes_insert" ON commandes;
DROP POLICY IF EXISTS "anon_commandes_update" ON commandes;

CREATE POLICY "anon_commandes_select" ON commandes
  FOR SELECT TO anon USING (true);

CREATE POLICY "anon_commandes_insert" ON commandes
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_commandes_update" ON commandes
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- DELETE : aucune policy → bloqué par RLS pour anon


-- ── TABLE parrainages ────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_parrainages_all"    ON parrainages;
DROP POLICY IF EXISTS "anon_parrainages_select" ON parrainages;
DROP POLICY IF EXISTS "anon_parrainages_insert" ON parrainages;

CREATE POLICY "anon_parrainages_select" ON parrainages
  FOR SELECT TO anon USING (true);

CREATE POLICY "anon_parrainages_insert" ON parrainages
  FOR INSERT TO anon WITH CHECK (true);

-- UPDATE : aucune policy → bloqué par RLS pour anon
-- DELETE : aucune policy → bloqué par RLS pour anon


-- ── Vérification après exécution ─────────────────────────────────
-- SELECT tablename, policyname, cmd, roles
-- FROM pg_policies
-- WHERE tablename IN ('clients', 'commandes', 'parrainages')
-- ORDER BY tablename, cmd;
--
-- Résultat attendu (9 lignes) :
--   clients     | anon_clients_select   | SELECT | {anon}
--   clients     | anon_clients_insert   | INSERT | {anon}
--   clients     | anon_clients_update   | UPDATE | {anon}
--   commandes   | anon_commandes_select | SELECT | {anon}
--   commandes   | anon_commandes_insert | INSERT | {anon}
--   commandes   | anon_commandes_update | UPDATE | {anon}
--   parrainages | anon_parrainages_select | SELECT | {anon}
--   parrainages | anon_parrainages_insert | INSERT | {anon}
