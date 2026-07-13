-- ═══════════════════════════════════════════════════════════════════════════
-- Migration : security-watchdog — tables + RLS + pg_cron
-- Date : 2026-07-13
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Table snapshots_fidelite ──────────────────────────────────────────
-- Photo quotidienne des cagnottes pour détecter les variations anormales.
-- Purgée automatiquement à 7 jours par la fonction watchdog.

CREATE TABLE IF NOT EXISTS snapshots_fidelite (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telephone     TEXT NOT NULL,
  cagnotte      NUMERIC NOT NULL DEFAULT 0,
  points_cumul  NUMERIC NOT NULL DEFAULT 0,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index pour les requêtes du watchdog (date + téléphone)
CREATE INDEX IF NOT EXISTS idx_snapshots_fidelite_date
  ON snapshots_fidelite (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_fidelite_tel_date
  ON snapshots_fidelite (telephone, snapshot_date);

-- RLS : aucun accès anon — uniquement service_role
ALTER TABLE snapshots_fidelite ENABLE ROW LEVEL SECURITY;
-- Aucune policy = aucun accès via anon/authenticated. service_role bypass RLS.


-- ── 2. Table watchdog_logs ───────────────────────────────────────────────
-- Historique de chaque exécution du watchdog pour consultation admin.

CREATE TABLE IF NOT EXISTS watchdog_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  alertes_count  INT NOT NULL DEFAULT 0,
  alertes_resume TEXT,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index pour requêtes admin (date DESC)
CREATE INDEX IF NOT EXISTS idx_watchdog_logs_date
  ON watchdog_logs (run_date DESC);

-- RLS : aucun accès anon — uniquement service_role
ALTER TABLE watchdog_logs ENABLE ROW LEVEL SECURITY;
-- Aucune policy = aucun accès via anon/authenticated. service_role bypass RLS.


-- ── 3. pg_cron — exécution chaque nuit à 4h00 (heure serveur UTC+0) ────
-- Ajuster le fuseau si nécessaire : 4h00 Paris = 2h00 UTC en été, 3h00 UTC en hiver.
-- On utilise 3h00 UTC comme compromis (≈ 4h-5h Paris selon saison).
--
-- IMPORTANT : pg_cron doit être activé dans les extensions Supabase :
--   Dashboard > Database > Extensions > pg_cron → Enable
--
-- La requête appelle la Edge Function via pg_net (extension HTTP de Supabase).
-- pg_net doit aussi être activé dans les extensions.

-- Activer les extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_cron SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;

-- Supprimer l'ancien job s'il existe (idempotent)
SELECT cron.unschedule('security-watchdog-nightly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'security-watchdog-nightly'
);

-- Créer le cron job : chaque nuit à 3h00 UTC (≈ 4h-5h Paris)
SELECT cron.schedule(
  'security-watchdog-nightly',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url    := current_setting('app.settings.supabase_url') || '/functions/v1/security-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := jsonb_build_object(
      'internal_secret', current_setting('app.settings.emp_token_secret')
    )
  );
  $$
);

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTE SUR pg_cron + pg_net :
--
-- Si current_setting('app.settings.supabase_url') n'est pas disponible,
-- remplacer manuellement les valeurs dans le SELECT ci-dessus :
--
--   url := 'https://VOTRE-PROJECT-REF.supabase.co/functions/v1/security-watchdog'
--   'Authorization', 'Bearer VOTRE_SERVICE_ROLE_KEY'
--   'internal_secret', 'VOTRE_EMP_TOKEN_SECRET'
--
-- Alternative si pg_net n'est pas disponible — appel via cURL wrapper :
--   SELECT cron.schedule('security-watchdog-nightly', '0 3 * * *',
--     $$ SELECT net.http_post(...) $$
--   );
--
-- ═══════════════════════════════════════════════════════════════════════════
