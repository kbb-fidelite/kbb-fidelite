#!/usr/bin/env node
/**
 * Test du système de fidélité refactorisé.
 *
 * Vérifie que le code JS (index.html) :
 *  1. Lit `passages` depuis la colonne DB `passages` (PAS `points`)
 *  2. Calcule le statut sur `points_cumul` (PAS `cagnotte`)
 *  3. Affiche `cagnotte` comme "points dépensables"
 *  4. N'écrit jamais `points:` dans dbUpdate (utilise `passages:`)
 *
 * Usage : node test-fidelite.js
 */

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const lines = html.split('\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     → ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function findLine(pattern) {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return { num: i + 1, text: lines[i].trim() };
  }
  return null;
}

function findAllLines(pattern) {
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) results.push({ num: i + 1, text: lines[i].trim() });
  }
  return results;
}

console.log('\n🔍 Test système de fidélité refactorisé\n');

// ─── 1. dbByTel ne mappe plus r.points vers passages ───────────────

console.log('1. dbByTel — séparation passages/points');

test('dbByTel lit r.passages (pas r.points)', () => {
  // La ligne principale de dbByTel qui construit l'objet retourné
  const match = findLine(/return\s*\{\.\.\.r,.*passages:parseInt\(r\.passages\)/);
  assert(match, 'dbByTel doit lire passages depuis r.passages, pas r.points');
});

test('dbByTel ne mappe plus r.points vers passages', () => {
  const bad = findLine(/passages:\s*r\.points/);
  assert(!bad, `Trouvé "passages:r.points" à la ligne ${bad?.num} — doit être "passages:r.passages"`);
});

// ─── 2. getLevel utilise points_cumul ──────────────────────────────

console.log('\n2. Statut basé sur points_cumul');

test('getLevel existe avec seuils 200/500', () => {
  const match = findLine(/function getLevel\(pts\)/);
  assert(match, 'getLevel() introuvable');
  const l200 = findLine(/pts>=200.*Argent/);
  const l500 = findLine(/pts>=500.*Or/);
  assert(l200, 'Seuil 200 pour Argent introuvable');
  assert(l500, 'Seuil 500 pour Or introuvable');
});

test('renderPortal calcule lvl sur cumul (points_cumul)', () => {
  const match = findLine(/const lvl=getLevel\(cumul\)/);
  assert(match, 'renderPortal doit appeler getLevel(cumul) — basé sur points_cumul');
});

test('renderPortal ne calcule PAS lvl sur pts (cagnotte)', () => {
  const bad = findLine(/const lvl=getLevel\(pts\)/);
  assert(!bad, `Trouvé "getLevel(pts)" à la ligne ${bad?.num} — doit être getLevel(cumul)`);
});

// ─── 3. Affichage ──────────────────────────────────────────────────

console.log('\n3. Affichage UI');

test('portal-cag affiche cagnotte (points dépensables)', () => {
  const match = findLine(/portal-cag/);
  assert(match, 'Élément portal-cag introuvable');
});

test('portal-passages affiche passages (pas points)', () => {
  const match = findLine(/portal-passages.*Passages/);
  assert(match, 'portal-passages doit avoir le label "Passages"');
});

test('portal-cumul affiche points cumulés (pas "Total dépensé" en €)', () => {
  const match = findLine(/portal-cumul.*Points cumulés/);
  assert(match, 'portal-cumul doit exister avec label "Points cumulés"');
});

test('Pas de portal-total avec €', () => {
  const bad = findLine(/portal-total.*Total dépensé/);
  assert(!bad, `"portal-total" avec "Total dépensé" encore présent ligne ${bad?.num}`);
});

// ─── 4. Écritures DB ──────────────────────────────────────────────

console.log('\n4. Écritures DB');

test('Aucun dbUpdate écrit points:c.passages', () => {
  const matches = findAllLines(/dbUpdate\([^)]*points:\s*c\.passages/);
  assert(matches.length === 0,
    `Trouvé ${matches.length} dbUpdate avec "points:c.passages" : lignes ${matches.map(m=>m.num).join(', ')}`);
});

test('Aucun dbUpdate écrit points:client.passages', () => {
  const matches = findAllLines(/dbUpdate\([^)]*points:\s*client\.passages/);
  assert(matches.length === 0,
    `Trouvé ${matches.length} dbUpdate avec "points:client.passages" : lignes ${matches.map(m=>m.num).join(', ')}`);
});

test('Crédits écrivent cagnotte + points_cumul', () => {
  // crediterPointsCommande doit écrire cagnotte ET points_cumul
  const match = findLine(/dbUpdate\(c\.id,\{cagnotte:c\.cagnotte,points_cumul:c\.points_cumul,passages:c\.passages\}/);
  assert(match, 'crediterPointsCommande doit écrire {cagnotte, points_cumul, passages}');
});

test('EMP_FIELDS contient passages (pas points)', () => {
  const match = findLine(/EMP_FIELDS=\[.*'passages'/);
  assert(match, 'EMP_FIELDS doit contenir "passages"');
  const bad = findLine(/EMP_FIELDS=\[.*'points'/);
  assert(!bad, `EMP_FIELDS contient encore 'points' ligne ${bad?.num} — doit être 'passages'`);
});

// ─── 5. Simulation : client avec cagnotte=600, points_cumul=600 ──

console.log('\n5. Simulation client cagnotte=600, points_cumul=600, passages=5');

test('getLevel(600) retourne Or', () => {
  // Simulate
  function getLevel(pts) {
    if(pts>=500) return {label:'Or',emoji:'👑',cls:'lvl-or',next:null,min:500};
    if(pts>=200) return {label:'Argent',emoji:'⭐',cls:'lvl-argent',next:500,min:200};
    return {label:'Bronze',emoji:'🥉',cls:'lvl-bronze',next:200,min:0};
  }
  const lvl = getLevel(600);
  assert(lvl.label === 'Or', `Attendu "Or", obtenu "${lvl.label}"`);
});

test('cagnotte=600 affichée comme "600 points" (pas "600 passages")', () => {
  // Le code met cagEl.textContent = pts (where pts = Math.floor(cagnotte))
  const match = findLine(/cagEl.*textContent\s*=\s*pts/);
  assert(match, 'portal-cag doit afficher pts (= cagnotte)');
});

test('passages=5 affiché séparément (pas 600)', () => {
  // portal-passages.textContent = c.passages
  const match = findLine(/portal-passages.*textContent\s*=\s*c\.passages/);
  assert(match, 'portal-passages doit afficher c.passages');
});

// ─── 6. Edge Functions ─────────────────────────────────────────────

console.log('\n6. Edge Functions');

const EF_DIR = path.join(__dirname, 'supabase', 'functions');

test('update-client EMP_FIELDS contient passages', () => {
  const f = fs.readFileSync(path.join(EF_DIR, 'update-client', 'index.ts'), 'utf8');
  assert(f.includes("'passages'"), 'update-client EMP_FIELDS doit contenir passages');
});

test('create-client initialise passages=0', () => {
  const f = fs.readFileSync(path.join(EF_DIR, 'create-client', 'index.ts'), 'utf8');
  assert(f.includes('passages:'), 'create-client doit initialiser passages');
});

test('create-checkout lit points_cumul depuis DB', () => {
  const f = fs.readFileSync(path.join(EF_DIR, 'create-checkout', 'index.ts'), 'utf8');
  assert(f.includes("select('points_cumul')"), 'create-checkout doit lire points_cumul depuis la DB');
  assert(f.includes('getStatutFromCumul'), 'create-checkout doit calculer le statut depuis points_cumul');
});

test('get-client-profile calcule statut sur points_cumul', () => {
  const f = fs.readFileSync(path.join(EF_DIR, 'get-client-profile', 'index.ts'), 'utf8');
  assert(f.includes('points_cumul'), 'get-client-profile doit référencer points_cumul');
  assert(f.includes("client.statut"), 'get-client-profile doit définir client.statut');
});

test('credit-referral-bonus incrémente points_cumul', () => {
  const f = fs.readFileSync(path.join(EF_DIR, 'credit-referral-bonus', 'index.ts'), 'utf8');
  assert(f.includes('points_cumul'), 'credit-referral-bonus doit incrémenter points_cumul');
});

// ─── Résultat ──────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Résultat : ${passed} passés, ${failed} échoués sur ${passed + failed} tests`);
if (failed > 0) {
  console.log('\n⛔ Des tests ont échoué — ne pas pusher !\n');
  process.exit(1);
} else {
  console.log('\n✅ Tous les tests passent — OK pour déploiement\n');
  process.exit(0);
}
