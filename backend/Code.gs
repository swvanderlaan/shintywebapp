/**
 * Shinty WebApp — back-end (Google Apps Script)
 *
 * Koppelt het invoerscherm (docs/beheer/) aan twee soorten Google Sheets:
 *   - het Programma-bestand (dit bestand): vast rooster, uitzonderingen,
 *     keeperstraining, wedstrijden, hallen, teams, gebruikers en log;
 *   - per team een Taken-bestand (link in tabblad Teams): spelers, taken, info.
 *
 * Installatie: zie README.md, sectie "Back-end installeren".
 *
 * VERSION_NAME = "Shinty WebApp Back-end"
 * VERSION      = "1.2.0"
 * VERSION_DATE = "2026-11-25"
 *
 * MIT License
 * Copyright (c) 2026 Sander W. van der Laan | s.w.vanderlaan [at] gmail [dot] com
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const VERSION = '1.2.0';
const TZ = 'Europe/Amsterdam';
const GITHUB_REPO = 'swvanderlaan/shintywebapp';
const GITHUB_WORKFLOW = 'build.yml';
const SESSION_SECONDS = 6 * 3600;      // inloggen blijft 6 uur geldig
const MAX_FAILS = 5;                   // na 5 foute pincodes ...
const LOCK_SECONDS = 15 * 60;          // ... 15 minuten geblokkeerd
const BUILD_DELAY_MS = 2 * 60 * 1000;  // wijzigingen 2 min bundelen voor de build

const DAGEN = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const SOORTEN_UITZ = ['extra', 'vervalt', 'gewijzigd'];
const GROEPEN = ['Keepers 1', 'Keepers 2', 'Keepers 3'];

/**
 * Tabellen die het invoerscherm mag lezen en schrijven.
 * file: 'programma' (dit bestand) of 'taken' (het Taken-bestand van het team).
 * team: kolom met de teamnaam (alleen in het Programma-bestand).
 * roles: wie mag schrijven. Lezen mag iedereen die het team mag zien.
 */
const TABLES = {
  rooster:     { file: 'programma', sheet: 'Vast rooster',   team: 'team', roles: ['admin', 'trainer'],
                 cols: ['team', 'dag', 'begin', 'eind', 'hal', 'trainers', 'vanaf', 'tm', 'opmerking'],
                 types: { begin: 'time', eind: 'time', vanaf: 'date', tm: 'date' } },
  uitz:        { file: 'programma', sheet: 'Uitzonderingen', team: 'team', roles: ['admin', 'trainer'],
                 cols: ['datum', 'team', 'soort', 'begin', 'eind', 'hal', 'trainers', 'opmerking'],
                 types: { datum: 'date', begin: 'time', eind: 'time' } },
  wedstrijden: { file: 'programma', sheet: 'Wedstrijden',    team: 'team', roles: ['admin', 'tm'],
                 cols: ['datum', 'team', 'soort', 'wedstrijd', 'tijd', 'hal', 'verzamelen', 'zaalleiding', 'opmerking'],
                 types: { datum: 'date' } },
  keepers:     { file: 'programma', sheet: 'Keeperstraining', roles: ['admin', 'keepertrainer'],
                 cols: ['datum', 'groep', 'begin', 'eind', 'hal', 'trainers', 'opmerking'],
                 types: { datum: 'date', begin: 'time', eind: 'time' } },
  taken:       { file: 'taken', sheet: 'Taken',   roles: ['admin', 'tm'],
                 cols: ['datum', 'activiteit', 'keeper', 'captain', 'fruit', 'rust', 'afwezig', 'rijden', 'rijdenOpm', 'zaaldienst', 'opmerking'],
                 types: { datum: 'date' } },
  spelers:     { file: 'taken', sheet: 'Spelers', roles: ['admin', 'tm'],
                 cols: ['naam', 'keeper', 'groep', 'elders', 'opmerking'], types: {} },
  info:        { file: 'taken', sheet: 'Info',    roles: ['admin', 'tm'],
                 cols: ['kop', 'tekst'], types: {} }
};

// ======================================================================
// Web-app ingangen
// ======================================================================

/** GET: alleen een levensteken, zodat je kunt zien dat de deployment werkt. */
function doGet() {
  return json_({ ok: true, service: 'Shinty WebApp back-end', version: VERSION });
}

/**
 * POST: alle acties. Het invoerscherm stuurt JSON als text/plain
 * (zo is er geen CORS-preflight nodig).
 */
function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Ongeldig verzoek.' });
  }
  try {
    switch (req.action) {
      case 'login':  return json_(login_(req));
      case 'load':   return json_(load_(req));
      case 'save':   return json_(save_(req));
      case 'delete': return json_(remove_(req));
      case 'export': return json_(exportTeam_(req));
      default:       return json_({ ok: false, error: 'Onbekende actie.' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ======================================================================
// Inloggen en sessies
// ======================================================================

/** Controleer naam + pincode, geef een sessiesleutel terug. */
function login_(req) {
  const name = String(req.name || '').trim();
  const key = 'fail:' + name.toLowerCase();
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(key) || 0);
  if (fails >= MAX_FAILS) {
    return { ok: false, error: 'Te vaak een verkeerde pincode. Probeer het over 15 minuten opnieuw.' };
  }
  const user = users_().find(u => u.name.toLowerCase() === name.toLowerCase());
  if (!user || hash_(String(req.pin || ''), user.salt) !== user.hash) {
    cache.put(key, String(fails + 1), LOCK_SECONDS);
    Utilities.sleep(600); // vertraag raden
    return { ok: false, error: 'Naam of pincode klopt niet.' };
  }
  cache.remove(key);
  const token = Utilities.getUuid();
  const session = { name: user.name, role: user.role, teams: user.teams };
  cache.put('sess:' + token, JSON.stringify(session), SESSION_SECONDS);
  return { ok: true, token: token, user: session, teams: visibleTeams_(session) };
}

/** Haal de sessie op of gooi een fout. */
function session_(token) {
  const raw = CacheService.getScriptCache().get('sess:' + String(token || ''));
  if (!raw) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  return JSON.parse(raw);
}

function users_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('USERS') || '[]');
}

function hash_(pin, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

/** Teams die deze gebruiker mag zien (uit tabblad Teams, rekening houdend met '*'). */
function visibleTeams_(session) {
  const all = readTable_(SpreadsheetApp.getActive().getSheetByName('Teams'), ['team', 'tms', 'trainers', 'taken', 'inApp', 'opmerking'], {})
    .map(r => r.v.team).filter(String);
  return session.teams.indexOf('*') >= 0 ? all : all.filter(t => session.teams.indexOf(t) >= 0);
}

function assertTeam_(session, team) {
  if (visibleTeams_(session).indexOf(team) < 0) throw new Error('Geen toegang tot team ' + team + '.');
}

function canWrite_(session, table) {
  return TABLES[table].roles.indexOf(session.role) >= 0 || session.role === 'admin';
}

// ======================================================================
// Lezen
// ======================================================================

/** Alles wat het invoerscherm voor één team nodig heeft. */
function load_(req) {
  const s = session_(req.token);
  const team = String(req.team || '');
  assertTeam_(s, team);
  const out = { ok: true, team: team, user: s, lists: lists_(team), tables: {} };
  Object.keys(TABLES).forEach(name => {
    const t = TABLES[name];
    let rows = readTable_(sheetFor_(t, team), t.cols, t.types);
    if (t.team) rows = rows.filter(r => r.v[t.team] === team);
    out.tables[name] = { rows: rows, canWrite: canWrite_(s, name) };
  });
  return out;
}

/** Keuzelijsten: hallen, spelers, dagen enz. */
function lists_(team) {
  const ss = SpreadsheetApp.getActive();
  const hallen = readTable_(ss.getSheetByName('Hallen'), ['hal', 'naam', 'adres', 'plaats', 'soort', 'opmerking'], {})
    .map(r => r.v).filter(h => h.hal);
  let spelers = [];
  try {
    spelers = readTable_(takenFile_(team).getSheetByName('Spelers'), TABLES.spelers.cols, {})
      .map(r => r.v.naam).filter(String);
  } catch (err) { /* team zonder Taken-bestand */ }
  return { hallen: hallen, spelers: spelers, dagen: DAGEN, soorten: SOORTEN_UITZ, groepen: GROEPEN };
}

/**
 * Lees een tabblad als lijst van {row, v, orig}. row is het rijnummer in de Sheet,
 * orig de opgemaakte waarden zoals gelezen (voor de controle op gelijktijdig bewerken).
 */
function readTable_(sheet, cols, types) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, cols.length).getValues();
  const out = [];
  values.forEach((row, i) => {
    if (row.every(c => c === '' || c === null)) return;
    const v = {};
    cols.forEach((c, j) => { v[c] = fmt_(row[j], types[c]); });
    out.push({ row: i + 2, v: v, orig: cols.map(c => v[c]) });
  });
  return out;
}

/** Zet een celwaarde om naar tekst: datums als jjjj-mm-dd, tijden als uu:mm. */
function fmt_(val, type) {
  if (val instanceof Date) {
    if (type === 'date') return Utilities.formatDate(val, TZ, 'yyyy-MM-dd');
    if (type === 'time' || val.getFullYear() < 1901) return Utilities.formatDate(val, TZ, 'HH:mm');
    return Utilities.formatDate(val, TZ, 'yyyy-MM-dd');
  }
  return val === null || val === undefined ? '' : String(val).trim();
}

function sheetFor_(t, team) {
  return t.file === 'programma'
    ? SpreadsheetApp.getActive().getSheetByName(t.sheet)
    : takenFile_(team).getSheetByName(t.sheet);
}

/** Het Taken-bestand van een team, via de link in tabblad Teams. */
function takenFile_(team) {
  const rows = readTable_(SpreadsheetApp.getActive().getSheetByName('Teams'), ['team', 'tms', 'trainers', 'taken', 'inApp', 'opmerking'], {});
  const r = rows.find(x => x.v.team === team);
  if (!r || !r.v.taken) throw new Error('Geen Taken-bestand ingesteld voor ' + team + '.');
  return SpreadsheetApp.openByUrl(r.v.taken);
}

// ======================================================================
// Schrijven
// ======================================================================

/**
 * Bewaar één regel. req: {token, team, table, row (null = nieuw), orig, values}.
 * Controleert rechten, gelijktijdig bewerken en inhoud; schrijft daarna en logt.
 */
function save_(req) {
  const s = session_(req.token);
  const team = String(req.team || '');
  const t = TABLES[req.table];
  if (!t) throw new Error('Onbekende tabel.');
  assertTeam_(s, team);
  if (!canWrite_(s, req.table)) throw new Error('Je mag dit onderdeel niet aanpassen.');

  const v = {};
  t.cols.forEach(c => { v[c] = String((req.values || {})[c] || '').trim(); });
  if (t.team) v[t.team] = team; // altijd het eigen team
  const errors = validate_(req.table, v, lists_(team));
  if (errors.length) return { ok: false, errors: errors };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheetFor_(t, team);
    let row = req.row ? Number(req.row) : null;
    if (row) checkUnchanged_(sheet, t, row, req.orig);
    if (!row) row = firstEmptyRow_(sheet, t.cols.length);
    const out = t.cols.map(c => toCell_(v[c], t.types[c]));
    sheet.getRange(row, 1, 1, out.length).setValues([out]);
    SpreadsheetApp.flush();
    log_(t, team, s.name, req.row ? 'gewijzigd' : 'toegevoegd', summary_(v));
    markDirty_();
    const fresh = readTable_(sheet, t.cols, t.types).find(r => r.row === row);
    return { ok: true, row: fresh };
  } finally {
    lock.releaseLock();
  }
}

/** Verwijder één regel (de rij wordt echt verwijderd). */
function remove_(req) {
  const s = session_(req.token);
  const team = String(req.team || '');
  const t = TABLES[req.table];
  if (!t) throw new Error('Onbekende tabel.');
  assertTeam_(s, team);
  if (!canWrite_(s, req.table)) throw new Error('Je mag dit onderdeel niet aanpassen.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheetFor_(t, team);
    const row = Number(req.row);
    checkUnchanged_(sheet, t, row, req.orig);
    const current = readTable_(sheet, t.cols, t.types).find(r => r.row === row);
    if (t.team && current.v[t.team] !== team) throw new Error('Deze regel hoort niet bij jouw team.');
    // Leegmaken in plaats van rij verwijderen: zo blijven de Controle-formules in rij 2 staan.
    sheet.getRange(row, 1, 1, t.cols.length).clearContent();
    log_(t, team, s.name, 'verwijderd', summary_(current.v));
    markDirty_();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Eerste rij (vanaf 2) waarvan de gegevenskolommen leeg zijn. getLastRow() telt
 * de Controle-kolom mee (die loopt door tot onderaan), dus die gebruiken we niet.
 */
function firstEmptyRow_(sheet, ncols) {
  const last = Math.max(sheet.getLastRow(), 2);
  const vals = sheet.getRange(2, 1, last - 1, ncols).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (vals[i].every(c => c === '' || c === null)) return i + 2;
  }
  return last + 1;
}

/** Weiger een wijziging als iemand anders de regel intussen heeft aangepast. */
function checkUnchanged_(sheet, t, row, orig) {
  const current = readTable_(sheet, t.cols, t.types).find(r => r.row === row);
  if (!current || JSON.stringify(current.orig) !== JSON.stringify(orig || [])) {
    throw new Error('Deze regel is intussen door iemand anders aangepast. Ververs de pagina en probeer het opnieuw.');
  }
}

/** Tekst naar celwaarde: datum als Date, tijd als 'uu:mm' (Sheets maakt er een tijd van). */
function toCell_(val, type) {
  if (!val) return '';
  if (type === 'date') {
    const p = val.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
  }
  if (/^[=+\-@]/.test(val)) return "'" + val; // geen formules via het invoerscherm
  return val;
}

/** Inhoudelijke controles; geeft een lijst met foutmeldingen. */
function validate_(table, v, lists) {
  const e = [];
  const halOk = h => lists.hallen.some(x => x.hal === h);
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const isTime = d => /^\d{1,2}:\d{2}$/.test(d);
  const mins = d => { const p = d.split(':').map(Number); return p[0] * 60 + p[1]; };
  const names = s => String(s || '').split(',').map(x => x.trim()).filter(String);
  const timeRange = () => {
    if (!isTime(v.begin) || !isTime(v.eind)) e.push('Vul een begin- en eindtijd in (uu:mm).');
    else if (mins(v.eind) <= mins(v.begin)) e.push('De eindtijd moet na de begintijd liggen.');
  };
  if (table === 'rooster') {
    if (DAGEN.indexOf(v.dag) < 0) e.push('Kies een dag.');
    timeRange();
    if (!halOk(v.hal)) e.push('Kies een hal uit de lijst.');
    if (!isDate(v.vanaf) || !isDate(v.tm)) e.push('Vul de periode in (vanaf en t/m).');
    else if (v.tm < v.vanaf) e.push('De einddatum ligt voor de begindatum.');
  }
  if (table === 'uitz') {
    if (!isDate(v.datum)) e.push('Vul een datum in.');
    if (SOORTEN_UITZ.indexOf(v.soort) < 0) e.push('Kies extra, vervalt of gewijzigd.');
    if (v.soort !== 'vervalt') { timeRange(); if (!halOk(v.hal)) e.push('Kies een hal uit de lijst.'); }
  }
  if (table === 'keepers') {
    if (!isDate(v.datum)) e.push('Vul een datum in.');
    if (GROEPEN.indexOf(v.groep) < 0) e.push('Kies een keepersgroep.');
    timeRange();
    if (!halOk(v.hal)) e.push('Kies een hal uit de lijst.');
  }
  if (table === 'wedstrijden') {
    if (!isDate(v.datum)) e.push('Vul een datum in.');
    if (['veld', 'zaal'].indexOf(v.soort) < 0) e.push('Kies veld of zaal.');
    if (!v.wedstrijd) e.push('Vul de wedstrijd(en) in.');
    if (!v.tijd) e.push('Vul de tijd(en) in.');
    if (!halOk(v.hal)) e.push('Kies een hal uit de lijst.');
    if (['ja', 'nee', ''].indexOf(v.zaalleiding) < 0) e.push('Zaalleiding is ja of nee.');
  }
  if (table === 'taken') {
    if (!isDate(v.datum)) e.push('Vul een datum in.');
    const known = n => lists.spelers.indexOf(n) >= 0;
    ['keeper', 'captain', 'fruit'].forEach(f => { if (v[f] && !known(v[f])) e.push(f + ': "' + v[f] + '" staat niet in de spelerslijst.'); });
    ['rust', 'afwezig'].forEach(f => names(v[f]).forEach(n => { if (!known(n)) e.push(f + ': "' + n + '" staat niet in de spelerslijst.'); }));
    const rides = parseRides_(v.rijden);
    if (Array.isArray(rides)) {
      const seen = [];
      rides.forEach(r => [r.van].concat(r.mee).forEach(n => {
        if (!known(n)) e.push('rijden: "' + n + '" staat niet in de spelerslijst.');
        else if (seen.indexOf(n) >= 0) e.push('rijden: ' + n + ' staat dubbel in het rijschema.');
        seen.push(n);
      }));
      names(v.afwezig).forEach(n => { if (seen.indexOf(n) >= 0) e.push('rijden: ' + n + ' is afwezig maar staat in het rijschema.'); });
    }
    const off = names(v.rust).concat(names(v.afwezig));
    ['keeper', 'captain'].forEach(f => { if (v[f] && off.indexOf(v[f]) >= 0) e.push(v[f] + ' is ' + f + ' maar ook rust/afwezig.'); });
  }
  if (table === 'spelers' && !v.naam) e.push('Vul een naam in.');
  if (table === 'info' && !v.kop) e.push('Vul een kop in.');
  return e;
}

/**
 * Rijschema uit een cel: 'volgt', 'eigen' of een lijst {van, mee, extra}.
 * Per regel 'Bestuurder → meerijder, meerijder + coaches X'. Zonder pijl: 'A, B' = ouders van A en B rijden.
 */
function parseRides_(text) {
  const t = String(text || '').trim(), low = t.toLowerCase();
  if (!t || low.indexOf('volgt') === 0) return 'volgt';
  if (low.indexOf('eigen gelegenheid') === 0) return 'eigen';
  const split = x => x.split(',').map(y => y.trim()).filter(String);
  const lines = t.replace(/;/g, '\n').split('\n').map(x => x.trim()).filter(String);
  if (!lines.some(x => /→|->/.test(x))) return split(lines.join(',')).map(n => ({ van: n, mee: [], extra: '' }));
  return lines.map(line => {
    const parts = line.replace('->', '→').split('→');
    const rest = (parts[1] || '').trim();
    const plus = rest.indexOf('+');
    const meeTxt = plus >= 0 ? rest.slice(0, plus) : rest;
    return { van: parts[0].trim(), mee: split(meeTxt), extra: plus >= 0 ? rest.slice(plus + 1).trim() : '' };
  });
}

function summary_(v) {
  return Object.keys(v).filter(k => v[k]).map(k => k + '=' + v[k]).join('; ').slice(0, 480);
}

/** Schrijf een regel in het Log-tabblad van het juiste bestand. */
function log_(t, team, who, action, details) {
  const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  if (t.file === 'programma') {
    SpreadsheetApp.getActive().getSheetByName('Log').appendRow([now, who, 'Programma', t.sheet, action, team + ': ' + details]);
  } else {
    takenFile_(team).getSheetByName('Log').appendRow([now, who, t.sheet, action, details]);
  }
}

// ======================================================================
// Export voor de build (GitHub Action)
// ======================================================================

/** Alle gegevens van één team; alleen met de exportsleutel. */
function exportTeam_(req) {
  const key = PropertiesService.getScriptProperties().getProperty('EXPORT_KEY');
  if (!key || req.key !== key) { Utilities.sleep(800); return { ok: false, error: 'Geen toegang.' }; }
  const team = String(req.team || '');
  const out = { ok: true, team: team, version: VERSION,
                exported: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
                hallen: lists_(team).hallen, tables: {} };
  Object.keys(TABLES).forEach(name => {
    const t = TABLES[name];
    let rows = readTable_(sheetFor_(t, team), t.cols, t.types).map(r => r.v);
    if (t.team) rows = rows.filter(r => r[t.team] === team);
    out.tables[name] = rows;
  });
  // Wedstrijden van teams waar spelers van dit team (ook) spelen, bv. een ander zaalteam
  const elders = (out.tables.spelers || []).map(sp => sp.elders).filter(String);
  const W = TABLES.wedstrijden;
  out.tables.eldersWedstrijden = readTable_(sheetFor_(W, team), W.cols, W.types)
    .map(r => r.v).filter(r => elders.indexOf(r.team) >= 0);
  return out;
}

// ======================================================================
// Build starten
// ======================================================================

function markDirty_() {
  PropertiesService.getScriptProperties().setProperty('DIRTY', String(Date.now()));
}

/** Tijdgestuurd (elke 5 min): start de build als er wijzigingen zijn. */
function buildIfDirty() {
  const p = PropertiesService.getScriptProperties();
  const dirty = Number(p.getProperty('DIRTY') || 0);
  if (!dirty || Date.now() - dirty < BUILD_DELAY_MS) return;
  if (dispatchBuild_()) p.deleteProperty('DIRTY');
}

/** Start de GitHub-workflow. Geeft true bij succes. */
function dispatchBuild_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { console.warn('Geen GitHub-token ingesteld'); return false; }
  const res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + GITHUB_REPO + '/actions/workflows/' + GITHUB_WORKFLOW + '/dispatches', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      payload: JSON.stringify({ ref: 'main' })
    });
  if (res.getResponseCode() !== 204) console.error('Build starten mislukt: ' + res.getResponseCode() + ' ' + res.getContentText());
  return res.getResponseCode() === 204;
}

// ======================================================================
// Beheer: menu in de Sheet
// ======================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Shinty WebApp')
    .addItem('1. Back-end instellen', 'setupBackend')
    .addItem('2. Pincodes verwerken (tabblad Gebruikers)', 'processUsers')
    .addItem('3. GitHub-token instellen', 'setGithubToken')
    .addSeparator()
    .addItem('Exportsleutel tonen', 'showExportKey')
    .addItem('App nu bijwerken', 'buildNow')
    .addToUi();
}

/** Eenmalig: exportsleutel, tabblad Gebruikers en de 5-minuten-trigger. */
function setupBackend() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('EXPORT_KEY')) p.setProperty('EXPORT_KEY', Utilities.getUuid() + Utilities.getUuid());
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('Gebruikers');
  if (!sh) {
    sh = ss.insertSheet('Gebruikers');
    sh.getRange(1, 1, 1, 5).setValues([['Naam', 'Rol', 'Teams', 'Nieuwe pincode', 'Status']]).setFontWeight('bold');
    sh.getRange(2, 1, 1, 5).setValues([['Sander', 'admin', '*', '', 'vul een pincode in en kies menu 2']]);
    sh.getRange('B2:B').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['admin', 'trainer', 'tm', 'keepertrainer'], true).build());
    sh.setFrozenRows(1);
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'buildIfDirty').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('buildIfDirty').timeBased().everyMinutes(5).create();
  SpreadsheetApp.getUi().alert('Back-end ingesteld. Vul nu in tabblad Gebruikers de pincodes in en kies menu 2.');
}

/**
 * Lees tabblad Gebruikers: nieuwe pincodes worden gehasht opgeslagen en daarna
 * uit de Sheet gewist. Gebruikers die niet meer in de lijst staan, verliezen toegang.
 */
function processUsers() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Gebruikers');
  const rows = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 5).getValues();
  const old = users_();
  const next = [];
  const problems = [];
  rows.forEach((r, i) => {
    const name = String(r[0]).trim(); if (!name) return;
    const role = String(r[1]).trim();
    const teams = String(r[2]).split(',').map(x => x.trim()).filter(String);
    const pin = String(r[3]).trim();
    const prev = old.find(u => u.name.toLowerCase() === name.toLowerCase());
    let rec = prev ? Object.assign({}, prev, { role: role, teams: teams }) : null;
    if (pin) {
      if (!/^\d{6,}$/.test(pin)) { problems.push(name + ': pincode moet minstens 6 cijfers zijn'); return; }
      const salt = Utilities.getUuid();
      rec = { name: name, role: role, teams: teams, salt: salt, hash: hash_(pin, salt) };
    }
    if (!rec) { problems.push(name + ': nog geen pincode'); return; }
    next.push(rec);
    sh.getRange(i + 2, 4, 1, 2).setValues([['', 'pincode ingesteld ' + Utilities.formatDate(new Date(), TZ, 'd-M-yyyy')]]);
  });
  PropertiesService.getScriptProperties().setProperty('USERS', JSON.stringify(next));
  SpreadsheetApp.getUi().alert(next.length + ' gebruiker(s) actief.' + (problems.length ? '\n\nLet op:\n' + problems.join('\n') : ''));
}

function setGithubToken() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('GitHub-token', 'Plak de fijnmazige token (alleen deze repo, Actions: lezen en schrijven).', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN', r.getResponseText().trim());
  ui.alert('Token opgeslagen.');
}

function showExportKey() {
  SpreadsheetApp.getUi().alert('Exportsleutel (zet deze als secret EXPORT_KEY in GitHub):\n\n' +
    PropertiesService.getScriptProperties().getProperty('EXPORT_KEY'));
}

function buildNow() {
  SpreadsheetApp.getUi().alert(dispatchBuild_() ? 'Build gestart. De app is over een paar minuten bijgewerkt.' : 'Build starten mislukt. Is de GitHub-token ingesteld?');
}
