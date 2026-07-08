# Projet KBB à la braise

PWA Vanilla JS · GitHub Pages · Supabase · Stripe · Uber Direct
URL production : https://kbb-fidelite.github.io/kbb-fidelite/

## Règles permanentes non négociables

1. RLS Supabase activé sur toutes les tables — ne jamais affaiblir ni recréer de policies anon sur clients/commandes/factures
2. Toutes les écritures/lectures sensibles via Edge Functions service_role uniquement
3. Jamais de SELECT direct anon sur les tables clients, commandes, factures
4. Toujours tester avant de pusher
5. Fournir le SQL avec RLS pour chaque nouvelle table
6. Aucune donnée sensible (clés API, tokens, téléphones complets) côté client ou dans les logs
7. Montants Stripe toujours recalculés et vérifiés côté serveur dans l'Edge Function
8. Uber Direct : credentials uniquement dans les secrets Supabase, jamais côté client
9. Après chaque tâche, TOUJOURS terminer par commit + push + afficher `git log --oneline -2` en preuve. Ne jamais décrire un travail comme terminé sans preuve de commit poussé.
