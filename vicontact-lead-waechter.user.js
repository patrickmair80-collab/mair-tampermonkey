// ==UserScript==
// @name         ViContact Lead-Wächter (Mair) v2
// @namespace    mair-gebaeudetechnik
// @version      2.1
// @updateURL    https://raw.githubusercontent.com/patrickmair80-collab/mair-tampermonkey/main/vicontact-lead-waechter.user.js
// @downloadURL  https://raw.githubusercontent.com/patrickmair80-collab/mair-tampermonkey/main/vicontact-lead-waechter.user.js
// @description  Prüft den ViContact-Marktplatz auf neue Leads bis MAX_KM und meldet / nimmt sie an.
// @match        https://vicontact.viessmann-climatesolutions.com/s/*
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      nominatim.openstreetmap.org
// @connect      ntfy.sh
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- Einstellungen ----------------
  const TEST_MODUS      = true;   // true = NUR MELDEN (Patrick nimmt selbst an); false = Leads bis MAX_KM automatisch annehmen
  const MAX_KM          = 25;
  const INTERVALL_SEK   = 20 * 60; // alle 20 Minuten reinschauen
  const START_STUNDE    = 5;      // nur 5–18 Uhr aktiv
  const ENDE_STUNDE     = 18;
  const HEIM            = { lat: 49.5858, lon: 10.8180 }; // Aurachtal (Fallback-Rechnung)
  const MARKTPLATZ      = '/s/marketplace';

  // Push aufs Handy + Mail (kostenlos über ntfy.sh). Es werden KEINE Kundendaten verschickt.
  // Kanal steht NICHT im Code (Skript liegt auf GitHub). Beim ersten Start einmal abfragen, dann nur lokal gespeichert.
  let NTFY_KANAL = GM_getValue('ntfyKanal', '');
  if (!NTFY_KANAL) {
    NTFY_KANAL = (prompt('Lead-Wächter: ntfy-Kanalname eingeben (aus der ntfy-App)') || '').trim();
    if (NTFY_KANAL) GM_setValue('ntfyKanal', NTFY_KANAL);
  }
  const MAIL_AN         = 'info@mair-haustechnik.de';
  // Mail geht bei ntfy.sh nur mit kostenlosem Konto: dort Zugangs-Token erstellen und hier eintragen (bleibt nur lokal).
  const NTFY_TOKEN      = GM_getValue('ntfyToken', ''); // in Tampermonkey > Skript > Speicher eintragen; leer = nur Push

  // Echte Spaltennamen aus dem Portal (data-label der Tabellenzellen)
  const SP = { nr: 'Anfrage', plz: 'PLZ', km: 'Entfernung zum Kunden', produkt: 'Geplantes Produkt', art: 'Anfragehintergrund', bis: 'Verfügbar bis' };
  // Graue Buttons "Bereits vergeben" / "Bereits angenommen" = nicht mehr verfügbar
  const BELEGT = /bereits|vergeben|angenommen/i;

  // ---------------- Hilfsfunktionen ----------------
  // Portal ist Salesforce/LWC: Inhalte stecken im Shadow-DOM
  function deepAll(root, sel, out = []) {
    root.querySelectorAll(sel).forEach(e => out.push(e));
    root.querySelectorAll('*').forEach(e => { if (e.shadowRoot) deepAll(e.shadowRoot, sel, out); });
    return out;
  }
  const zelle = (tr, label) => {
    const td = tr.querySelector(`td[data-label="${label}"]`);
    return td ? td.innerText.trim() : '';
  };
  const gesehen = () => new Set(JSON.parse(GM_getValue('gesehen', '[]')));
  const merke = nr => { const s = gesehen(); s.add(nr); GM_setValue('gesehen', JSON.stringify([...s].slice(-500))); };
  const imZeitfenster = () => { const h = new Date().getHours(); return h >= START_STUNDE && h < ENDE_STUNDE; };

  function push(titel, text) {
    // Gleiche Meldung höchstens alle 2 Std. (kein Dauer-Spam bei Login-Problemen)
    const key = titel + text, jetzt = Date.now();
    if (GM_getValue('letztePush', '') === key && jetzt - GM_getValue('letztePushZeit', 0) < 2 * 3600 * 1000) return;
    GM_setValue('letztePush', key); GM_setValue('letztePushZeit', jetzt);
    const senden = (extra, auth) => GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://ntfy.sh/',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { Authorization: 'Bearer ' + NTFY_TOKEN } : {}),
      data: JSON.stringify(Object.assign({
        topic: NTFY_KANAL, title: titel, message: text, priority: 5, tags: ['bell'],
        click: 'https://vicontact.viessmann-climatesolutions.com/s/marketplace'
      }, extra)),
      onload: r => { if (r.status >= 300) console.log('[Lead-Wächter] ntfy Fehler', r.status, r.responseText); },
      onerror: () => console.log('[Lead-Wächter] Push fehlgeschlagen')
    });
    if (!NTFY_KANAL) return;
    senden({}, false);                                   // Push aufs Handy (läuft immer)
    if (NTFY_TOKEN) senden({ email: MAIL_AN }, true);    // Mail nur mit ntfy-Konto
  }

  function melde(titel, text) {
    try { push(titel, text); } catch (e) {}
    try { GM_notification({ title: titel, text, timeout: 0 }); } catch (e) {}
    try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play(); } catch (e) {}
    console.log('[Lead-Wächter]', titel, text);
  }

  // Fallback, falls das Portal mal keine km anzeigt: PLZ -> Koordinaten (OSM, max 1 Abfrage/Sek., mit Speicher)
  function kmPerPlz(plz) {
    const cache = JSON.parse(GM_getValue('plzCache', '{}'));
    const rechne = c => {
      const R = 6371, r = x => x * Math.PI / 180;
      const dLat = r(c.lat - HEIM.lat), dLon = r(c.lon - HEIM.lon);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(HEIM.lat)) * Math.cos(r(c.lat)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    if (cache[plz]) return Promise.resolve(rechne(cache[plz]));
    return new Promise(res => GM_xmlhttpRequest({
      method: 'GET',
      url: `https://nominatim.openstreetmap.org/search?postalcode=${plz}&country=de&format=json&limit=1`,
      headers: { 'Accept-Language': 'de' },
      onload: r => {
        try {
          const j = JSON.parse(r.responseText)[0];
          cache[plz] = { lat: +j.lat, lon: +j.lon };
          GM_setValue('plzCache', JSON.stringify(cache));
          res(rechne(cache[plz]));
        } catch (e) { res(null); }
      },
      onerror: () => res(null)
    }));
  }

  // ---------------- Hauptprüfung ----------------
  async function pruefe() {
    // Ausgeloggt? (Login-Seite statt Portal)
    if (/login/i.test(location.pathname) || deepAll(document, 'input[type="password"]').length) {
      melde('ViContact: Login weg!', 'Bitte neu einloggen, der Lead-Wächter läuft sonst nicht.');
      return;
    }
    const zeilen = deepAll(document, 'tr').filter(tr => tr.querySelector(`td[data-label="${SP.plz}"]`));
    for (const tr of zeilen) {
      const btn = tr.querySelector('button');
      if (!btn || btn.disabled || BELEGT.test(btn.innerText) || btn.classList.contains('button-grey')) continue;

      const nr = zelle(tr, SP.nr), plz = zelle(tr, SP.plz);
      let km = parseFloat(zelle(tr, SP.km).replace(',', '.'));
      if (isNaN(km) && /^\d{5}$/.test(plz)) km = await kmPerPlz(plz);
      const info = `${nr} · ${zelle(tr, SP.art)} · ${zelle(tr, SP.produkt)} · PLZ ${plz} · ${km != null ? km.toFixed(1) + ' km' : 'km unbekannt'}`;

      if (gesehen().has(nr)) continue;
      merke(nr);

      if (km == null || km > MAX_KM) { melde('Lead zu weit / unklar', info); continue; }

      tr.style.outline = '3px solid red';
      btn.style.background = 'red'; btn.style.color = 'white';
      // Button-Text beim ersten echten Lead festhalten (zum Nachjustieren)
      GM_setValue('letzterButtonText', btn.innerText.trim());

      if (TEST_MODUS) {
        melde('NEUER LEAD (Test) – selbst annehmen!', `${info} · Button: "${btn.innerText.trim()}"`);
      } else {
        btn.click();
        melde('Lead angenommen', info);
        // Falls eine Bestätigungs-Abfrage kommt, wird sie hier NICHT automatisch bestätigt.
      }
    }
  }

  // ---------------- Login ----------------
  // Kein Passwort im Skript! Nur wenn Chrome die Felder selbst ausgefüllt hat, wird "Anmelden" geklickt.
  function versucheLogin() {
    const pw = deepAll(document, 'input[type="password"]')[0];
    if (!pw) return false;
    const user = deepAll(document, 'input[type="email"], input[type="text"]').find(i => i.value);
    const knopf = deepAll(document, 'button, input[type="submit"]').find(b => /anmelden|einloggen|login|log in/i.test(b.innerText || b.value || ''));
    if (pw.value && user && knopf) { knopf.click(); console.log('[Lead-Wächter] Auto-Login über gespeicherte Chrome-Daten'); }
    else melde('ViContact: Login nötig', 'Bitte einmal einloggen (Chrome-Passwort speichern + "Angemeldet bleiben"). Danach läuft der Wächter weiter.');
    return true;
  }

  // ---------------- Startseite: Kachel "Neue Leads" lesen ----------------
  // Die Kacheln stecken in einem iframe auf der Startseite, Text z. B. "0\nNeue Leads\n4\nKunden kontaktieren ..."
  function neueLeadsZahl() {
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const t = f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText : '';
        const m = t.match(/(\d+)\s*\n\s*Neue Leads/);
        if (m) return parseInt(m[1], 10);
      } catch (e) {}
    }
    return null; // Kachel nicht gefunden
  }

  // ---------------- Ablauf ----------------
  // Tab bleibt auf der Startseite /s/. Alle 20 Min. neu laden, Kachel lesen.
  // Zahl > 0 -> Marktplatz öffnen, annehmen, zurück zur Startseite.
  const STARTSEITE = '/s/';
  const zurStartseite = (sek) => setTimeout(() => { location.href = STARTSEITE; }, sek * 1000);
  const istStart = location.pathname === STARTSEITE || location.pathname === '/s';

  setTimeout(async () => {
    if (versucheLogin()) { zurStartseite(INTERVALL_SEK); return; }   // Login-Seite
    if (location.pathname.startsWith(MARKTPLATZ)) {
      if (GM_getValue('vomWaechter', false)) {                        // nur wenn der Wächter uns hergeschickt hat
        GM_setValue('vomWaechter', false);
        await pruefe();
        zurStartseite(30);                                            // kurz Zeit für evtl. Bestätigung, dann zurück
      }
      return;
    }
    if (!istStart) return;                                            // andere Portalseiten nicht stören
    if (imZeitfenster()) {
      const n = neueLeadsZahl();
      if (n === null) melde('ViContact: Kachel nicht lesbar', 'Startseite geladen, aber "Neue Leads" nicht gefunden.');
      else if (n > 0) {
        // Nur einmal pro neuer Zahl melden, nicht alle 20 Min. dasselbe
        if (n !== GM_getValue('letzteZahl', 0)) {
          melde(`ViContact: ${n} neue${n > 1 ? '' : 'r'} Lead${n > 1 ? 's' : ''}!`, 'Jetzt im Portal unter "Neue Leads" annehmen.');
          GM_setValue('letzteZahl', n);
          if (!TEST_MODUS) { GM_setValue('vomWaechter', true); location.href = MARKTPLATZ; return; }
        }
      } else GM_setValue('letzteZahl', 0);
    }
    setTimeout(() => location.reload(), INTERVALL_SEK * 1000);
  }, 8000); // Portal + Kachel-iframe brauchen ein paar Sekunden
})();
