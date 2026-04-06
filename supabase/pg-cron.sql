-- ══════════════════════════════════════════════════════════════════
-- KBB — Planification automatique via pg_cron
-- Prérequis : Supabase Pro (pg_cron disponible)
--
-- 1. Activer l'extension pg_cron dans Supabase :
--    Dashboard → Database → Extensions → pg_cron → Enable
--
-- 2. Activer l'extension pg_net (pour les appels HTTP) :
--    Dashboard → Database → Extensions → pg_net → Enable
--
-- 3. Remplacer YOUR_PROJECT_REF par votre référence projet Supabase
--    (visible dans Settings → API → URL : https://YOUR_PROJECT_REF.supabase.co)
--
-- 4. Remplacer YOUR_SERVICE_ROLE_KEY par votre clé service_role
--    (Settings → API → service_role key)
-- ══════════════════════════════════════════════════════════════════

-- ─── Planifier l'envoi automatique le 1er de chaque mois à 6h00 ─
SELECT cron.schedule(
  'kbb-monthly-accounting',           -- nom du job (unique)
  '0 6 1 * *',                        -- cron expression : 1er du mois, 6h00 UTC
  $$
  SELECT
    net.http_post(
      url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-monthly-accounting',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);

-- ─── Vérifier les jobs planifiés ─────────────────────────────────
-- SELECT * FROM cron.job;

-- ─── Supprimer un job si besoin ──────────────────────────────────
-- SELECT cron.unschedule('kbb-monthly-accounting');

-- ─── Historique des exécutions ───────────────────────────────────
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
