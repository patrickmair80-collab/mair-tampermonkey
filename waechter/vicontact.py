"""ViContact Lead-Wächter (Cloud) – Mair Gebäudetechnik
Loggt sich ins ViContact-Portal ein, liest die Kachel "Neue Leads" und schickt bei neuen Leads
eine Push-Nachricht über ntfy. Es werden KEINE Kundendaten gelesen, ausgegeben oder verschickt.
Zugangsdaten kommen nur aus GitHub-Secrets. Logs sind öffentlich -> nie Daten ausgeben!
"""
import base64, hashlib, json, os, re, sys, urllib.request
from pathlib import Path
from cryptography.fernet import Fernet
from playwright.sync_api import sync_playwright

BASE = "https://vicontact.viessmann-climatesolutions.com"
STATE = Path("state"); STATE.mkdir(exist_ok=True)
COOKIES, MERK = STATE / "cookies.json", STATE / "merk.json"
USER = os.environ.get("VICONTACT_USER", "")
PW = os.environ.get("VICONTACT_PASS", "")
TOPIC = os.environ.get("NTFY_TOPIC", "")
TOKEN = os.environ.get("NTFY_TOKEN", "")
MAIL = os.environ.get("NTFY_MAIL", "")


# Sitzungs-Cookies liegen nur VERSCHLÜSSELT im Actions-Cache (Schlüssel aus dem Secret abgeleitet,
# fremde Forks/PRs bekommen keine Secrets und können den Cache damit nicht lesen).
SITZUNG = STATE / "sitzung.enc"


def _fernet():
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("mair-vc|" + PW).encode()).digest()))


def sitzung_laden():
    try:
        COOKIES.write_bytes(_fernet().decrypt(SITZUNG.read_bytes())); return True
    except Exception:
        return False


def sitzung_sichern():
    try:
        SITZUNG.write_bytes(_fernet().encrypt(COOKIES.read_bytes()))
    finally:
        COOKIES.unlink(missing_ok=True)  # Klartext nie im Cache lassen


def merk():
    try:
        return json.loads(MERK.read_text())
    except Exception:
        return {"letzteZahl": 0, "letzteWarnung": ""}


def push(titel, text, mail=False):
    if not TOPIC:
        print("kein NTFY_TOPIC gesetzt"); return
    body = {"topic": TOPIC, "title": titel, "message": text, "priority": 5, "tags": ["bell"],
            "click": BASE + "/s/marketplace"}
    if mail and TOKEN and MAIL:
        body["email"] = MAIL
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    req = urllib.request.Request("https://ntfy.sh/", data=json.dumps(body).encode(), headers=headers)
    try:
        urllib.request.urlopen(req, timeout=20); print("Push gesendet")
    except Exception as e:
        print("Push-Fehler:", type(e).__name__)


def warne(m, key, titel, text):
    # gleiche Warnung nicht bei jedem Lauf wiederholen
    if m.get("letzteWarnung") != key:
        push(titel, text); m["letzteWarnung"] = key


def leads_zahl(page):
    # Kacheln stecken in einem iframe: "0\nNeue Leads\n4\nKunden kontaktieren ..."
    for f in page.frames:
        try:
            t = f.locator("body").inner_text(timeout=3000)
            hit = re.search(r"(\d+)\s*\n\s*Neue Leads", t)
            if hit:
                return int(hit.group(1))
        except Exception:
            pass
    return None


def main():
    m = merk()
    if not (USER and PW):
        print("Secrets VICONTACT_USER / VICONTACT_PASS fehlen"); sys.exit(1)
    try:
        lauf(m)
    finally:
        if COOKIES.exists():
            sitzung_sichern()
        MERK.write_text(json.dumps(m))


def lauf(m):
    hat_sitzung = sitzung_laden()
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(locale="de-DE", storage_state=str(COOKIES) if hat_sitzung else None)
        page = ctx.new_page()
        page.goto(BASE + "/s/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(8000)

        if "/login" in page.url or page.locator("input[type=password]").count():
            print("Login nötig")
            # ViContact-Login läuft über den Button "Login mit Climate Solutions ..." (Viessmann-Konto)
            page.goto(BASE + "/s/login/", wait_until="networkidle", timeout=60000)
            page.wait_for_timeout(5000)
            klickbar = page.locator("a:visible, button:visible, [role=button]:visible, input[type=submit]:visible")
            # Echter Button heißt "Jetzt einloggen" (NICHT der Registrieren-Link mit "Climate Solutions")
            sso = page.locator("button:visible").filter(has_text=re.compile(r"einloggen|anmelden|log ?in", re.I))
            if not sso.count():
                print("SSO-Button nicht gefunden. Klickbare Elemente:")
                for e in klickbar.all()[:20]:
                    try:
                        print("  -", (e.inner_text(timeout=1000) or e.get_attribute("value") or "")[:50].replace("\n", " "))
                    except Exception:
                        pass
                warne(m, "loginseite", "ViContact: Login-Seite unbekannt", "Cloud-Wächter findet den Login-Button nicht.")
                b.close(); return
            alt = page.url
            # Fehlersuche: fehlgeschlagene Seitenaufrufe nur mit Servername + Fehlerart ausgeben
            page.on("requestfailed", lambda r: print("  Aufruf fehlgeschlagen:", r.url.split("/")[2],
                                                     "|", r.failure) if r.resource_type == "document" else None)
            try:
                href = sso.first.get_attribute("href") or ""
                if href:
                    print("  SSO-Ziel-Server:", href.split("/")[2] if "//" in href else href.split("?")[0])
            except Exception:
                pass
            sso.first.click()
            try:
                page.wait_for_url(lambda u: u != alt, timeout=30000)
            except Exception:
                pass
            page.wait_for_load_state("networkidle", timeout=60000)
            print("Login-Anbieter:", page.url.split("?")[0].split("/")[2])  # nur der Servername

            def sichtbar(sel):
                return page.locator(sel + ":visible").first

            textfeld = ("input:not([type=password]):not([type=hidden]):not([type=checkbox])"
                        ":not([type=submit]):not([type=button]):not([type=radio])")
            knopf_re = re.compile(r"anmelden|log ?in|einloggen|weiter|next|continue|sign in", re.I)

            def absenden(feld):
                k = page.locator("button:visible, input[type=submit]:visible").filter(has_text=knopf_re)
                if k.count():
                    k.first.click()
                else:
                    feld.press("Enter")

            try:
                sichtbar(textfeld).wait_for(timeout=30000)
                sichtbar(textfeld).fill(USER)
                if not page.locator("input[type=password]:visible").count():
                    absenden(sichtbar(textfeld))   # zweistufig: erst E-Mail, dann Passwort
                sichtbar("input[type=password]").wait_for(timeout=30000)
                sichtbar("input[type=password]").fill(PW)
                absenden(sichtbar("input[type=password]"))
            except Exception:
                print("Login-Formular nicht wie erwartet | Titel:", page.title()[:60])
                try:
                    print("  Text:", page.locator("body").inner_text(timeout=3000)[:200].replace("\n", " "))
                except Exception:
                    pass
                warne(m, "loginform", "ViContact: Login-Formular unbekannt", "Cloud-Wächter kommt mit dem Login nicht klar.")
                b.close(); return
            page.wait_for_timeout(12000)
            if re.search(r"verif|identity|bestätig", page.url + " " + page.title(), re.I) or \
               page.locator("input[name*=code i], input[id*=code i]").count():
                print("Viessmann will einen Bestätigungscode")
                warne(m, "code", "ViContact: Login braucht Code",
                      "Der Cloud-Wächter kann sich nicht einloggen (Bestätigungscode).")
                MERK.write_text(json.dumps(m)); b.close(); return
            if "vicontact" not in page.url or "/login" in page.url:
                print("Login fehlgeschlagen | Server:", page.url.split("/")[2], "| Titel:", page.title()[:60])
                warne(m, "login", "ViContact: Login fehlgeschlagen",
                      "Cloud-Wächter kommt nicht ins Portal. Passwort geändert?")
                MERK.write_text(json.dumps(m)); b.close(); return
            page.goto(BASE + "/s/", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(8000)

        n = leads_zahl(page)
        if n is None:
            # Kachel-Seite direkt laden (das ist der Inhalt des Startseiten-iframes)
            page.goto(BASE + "/PCC_HomePage?isdtp=p1", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)
            n = leads_zahl(page)
        print("Neue Leads:", n)  # nur die Zahl, keine Kundendaten
        if n is None:
            warne(m, "kachel", "ViContact: Kachel nicht lesbar", "Cloud-Wächter findet 'Neue Leads' nicht.")
        else:
            m["letzteWarnung"] = ""
            if n > 0 and n != m.get("letzteZahl", 0):
                push(f"ViContact: {n} neue{'' if n > 1 else 'r'} Lead{'s' if n > 1 else ''}!",
                     "Jetzt im Portal unter 'Neue Leads' annehmen.", mail=True)
            m["letzteZahl"] = n
        ctx.storage_state(path=str(COOKIES))
        b.close()
    MERK.write_text(json.dumps(m))


if __name__ == "__main__":
    main()
