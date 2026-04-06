// Supabase Edge Function — send-monthly-accounting
// Envoie le rapport comptable mensuel par email (via Resend)
//
// Secrets requis :
//   RESEND_API_KEY     — clé API Resend (resend.com, gratuit jusqu'à 100 emails/jour)
//   SUPABASE_URL       — automatiquement injecté par Supabase
//   SUPABASE_SERVICE_ROLE_KEY — automatiquement injecté
//
// Planification automatique (pg_cron) : voir pg-cron.sql
// Déclenchement manuel : dashboard patron → bouton "Envoyer rapport mensuel"
//
// Déploiement : supabase functions deploy send-monthly-accounting

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MOIS_FR = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const DEST_EMAIL = 'St2z39100@gmail.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supaUrl  = Deno.env.get('SUPABASE_URL')!;
    const supaKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendKey = Deno.env.get('RESEND_API_KEY');

    const supabase = createClient(supaUrl, supaKey);

    // ── Période : mois précédent ──────────────────────────────────
    const now      = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year     = prevMonth.getFullYear();
    const month    = prevMonth.getMonth(); // 0-based
    const moisNom  = MOIS_FR[month];
    const monthStr = String(month + 1).padStart(2, '0');

    const dateFrom = `${year}-${monthStr}-01T00:00:00Z`;
    const dateTo   = new Date(year, month + 1, 0, 23, 59, 59).toISOString();

    // ── Récupérer les factures du mois ────────────────────────────
    const { data: factures, error } = await supabase
      .from('factures')
      .select('*')
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: true });

    if (error) throw error;

    const rows = factures || [];

    // ── Calcul des totaux ─────────────────────────────────────────
    const totHT10  = rows.reduce((s, f) => s + Number(f.total_ht_10 || 0), 0);
    const totTVA10 = rows.reduce((s, f) => s + Number(f.tva_10 || 0), 0);
    const totHT55  = rows.reduce((s, f) => s + Number(f.total_ht_55 || 0), 0);
    const totTVA55 = rows.reduce((s, f) => s + Number(f.tva_55 || 0), 0);
    const totTTC   = rows.reduce((s, f) => s + Number(f.total_ttc || 0), 0);
    const nb       = rows.length;
    const panier   = nb > 0 ? totTTC / nb : 0;

    const fmt = (n: number) => n.toFixed(2).replace('.', ',') + ' €';

    // ── Générer le CSV ────────────────────────────────────────────
    const bom = '\uFEFF';
    const sep = ';';
    const header = [
      'Date', 'Heure', 'N° Facture', 'N° Commande', 'Client',
      'HT 10% (€)', 'TVA 10% (€)', 'HT 5,5% (€)', 'TVA 5,5% (€)',
      'TTC (€)', 'Paiement', 'Réf. Stripe'
    ].join(sep);

    const lines = rows.map(f => {
      const dt    = new Date(f.date);
      const date  = dt.toLocaleDateString('fr-FR');
      const heure = dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const cmdNum = f.commande_id ? '#KBB-' + String(f.commande_id).padStart(3, '0') : '';
      return [
        date, heure, f.numero_facture || '', cmdNum, f.client_prenom || '',
        String(f.total_ht_10 || 0).replace('.', ','),
        String(f.tva_10 || 0).replace('.', ','),
        String(f.total_ht_55 || 0).replace('.', ','),
        String(f.tva_55 || 0).replace('.', ','),
        String(f.total_ttc || 0).replace('.', ','),
        f.moyen_paiement || '', f.ref_stripe || ''
      ].join(sep);
    });

    const csv = bom + header + '\n' + lines.join('\n');

    // ── Corps de l'email ──────────────────────────────────────────
    const body = `Comptabilité KBB à la braise — ${moisNom} ${year}
SAS ST2Z · SIRET 98736246400016
5 rue François Xavier Bichat · 39100 Dole

══════════════════════════════════════
RÉSUMÉ DE ${moisNom.toUpperCase()} ${year}
══════════════════════════════════════

CA Total HT (TVA 10%)    : ${fmt(totHT10)}
TVA 10% collectée        : ${fmt(totTVA10)}

CA Total HT (TVA 5,5%)   : ${fmt(totHT55)}
TVA 5,5% collectée       : ${fmt(totTVA55)}

Total TVA collectée      : ${fmt(totTVA10 + totTVA55)}
──────────────────────────────────────
CA Total TTC             : ${fmt(totTTC)}
Nombre de factures       : ${nb}
Panier moyen TTC         : ${fmt(panier)}
══════════════════════════════════════

Voir le détail complet dans la pièce jointe CSV.
Le fichier est compatible Excel et logiciels comptables (UTF-8, séparateur ;).

--
KBB à la braise · 09 81 50 27 57
St2z39100@gmail.com
`;

    // ── Envoi email via Resend ────────────────────────────────────
    if (!resendKey) {
      console.warn('RESEND_API_KEY non configurée — email non envoyé');
      return new Response(
        JSON.stringify({ ok: true, nb, note: 'resend_key_missing' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Encoder le CSV en base64
    const encoder = new TextEncoder();
    const csvBytes = encoder.encode(csv);
    const csvBase64 = btoa(String.fromCharCode(...csvBytes));

    const emailPayload = {
      from:    'KBB Comptabilité <onboarding@resend.dev>',
      to:      [DEST_EMAIL],
      subject: `KBB — Comptabilité ${moisNom} ${year}`,
      text:    body,
      attachments: [{
        filename: `kbb-compta-${moisNom.toLowerCase()}-${year}.csv`,
        content:  csvBase64,
      }],
    };

    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(emailPayload),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      throw new Error('Resend error: ' + JSON.stringify(emailData));
    }

    console.log(`Rapport ${moisNom} ${year} envoyé : ${nb} factures, TTC total ${fmt(totTTC)}`);

    return new Response(
      JSON.stringify({ ok: true, nb, total_ttc: totTTC, email_id: emailData.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('send-monthly-accounting error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
