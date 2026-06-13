-- Migration : colonnes Uber Direct pour la table commandes
-- À exécuter dans l'éditeur SQL Supabase

ALTER TABLE commandes
  ADD COLUMN IF NOT EXISTS uber_delivery_id  TEXT,
  ADD COLUMN IF NOT EXISTS uber_tracking_url TEXT,
  ADD COLUMN IF NOT EXISTS uber_status       TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address  JSONB;

-- Index pour retrouver une commande par delivery_id depuis le webhook
CREATE INDEX IF NOT EXISTS idx_commandes_uber_delivery_id
  ON commandes (uber_delivery_id)
  WHERE uber_delivery_id IS NOT NULL;

COMMENT ON COLUMN commandes.uber_delivery_id  IS 'Identifiant Uber Direct (del_...)';
COMMENT ON COLUMN commandes.uber_tracking_url IS 'URL de suivi livreur fournie par Uber Direct';
COMMENT ON COLUMN commandes.uber_status       IS 'Statut Uber : pickup_enroute | pickup_arrived | dropoff_enroute | dropoff_arrived | delivered | cancelled';
COMMENT ON COLUMN commandes.delivery_address  IS 'Adresse livraison client {street, zip, city, notes}';
