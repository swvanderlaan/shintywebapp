#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — bouwt de wachtwoord-beveiligde team-app en de teamagenda (zonder namen).

Werking
-------
1. Leest de team-gegevens (JSON) uit --input. Dit bestand bevat namen van
   kinderen en hoort NOOIT in git (data/ staat in .gitignore).
2. Controleert de gegevens (verplichte velden, datums, onbekende namen,
   rust/afwezig én een taak op dezelfde dag).
3. Versleutelt de gegevens met de wachtzin (PBKDF2-SHA256 -> AES-256-GCM)
   en schrijft docs/<team>/index.html met alleen versleutelde tekst.
4. Schrijft docs/agenda/<feed_token>.ics: trainingen en wedstrijden zonder
   namen, voor agenda-abonnementen die zichzelf bijwerken.

De wachtzin wordt gelezen uit een omgevingsvariabele (standaard SHINTY_PW),
nooit uit een bestand of de commandoregel. Hoofdletters en spaties maken niet
uit; de app normaliseert op dezelfde manier.

Gebruik
-------
    SHINTY_PW='...' python3 scripts/build.py --input data/jo11-1.json --team jo11-1

MIT License

Copyright (c) 2026 Sander W. van der Laan | s.w.vanderlaan [at] gmail [dot] com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

VERSION_NAME = "Shinty WebApp Builder"
VERSION = "1.2.0"
VERSION_DATE = "2026-11-25"

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import json
import logging
import os
import re
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

PBKDF2_ITER = 310_000          # zelfde waarde staat in de vault, de app leest hem daaruit
ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("build")


# ---------------------------------------------------------------- hulpfuncties
def parse_args(argv=None):
    """Lees de commandoregel-argumenten."""
    p = argparse.ArgumentParser(
        description=f"{VERSION_NAME} v{VERSION} ({VERSION_DATE}): bouwt de versleutelde team-app en de teamagenda.")
    p.add_argument("--input", required=True, help="JSON met de teamgegevens (bevat namen; niet in git)")
    p.add_argument("--team", required=True, help="team-id zoals in config/teams.json, bv. jo11-1")
    p.add_argument("--config", default=str(ROOT / "config" / "teams.json"), help="teamconfiguratie")
    p.add_argument("--template", default=str(ROOT / "template" / "team.html"), help="HTML-sjabloon")
    p.add_argument("--outdir", default=str(ROOT / "docs"), help="map die GitHub Pages publiceert")
    p.add_argument("--password-env", default="SHINTY_PW", help="omgevingsvariabele met de wachtzin")
    p.add_argument("--strict", action="store_true", help="stop bij waarschuwingen in de controle")
    p.add_argument("--version", action="version", version=f"{VERSION_NAME} {VERSION} ({VERSION_DATE})")
    return p.parse_args(argv)


def setup_logging(input_path: Path, team: str) -> Path:
    """Log naar scherm en naar een gedateerd bestand naast het --input bestand."""
    stamp = dt.date.today().isoformat()
    logfile = input_path.parent / f"{stamp}_{team}_build.log"
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    log.setLevel(logging.INFO)
    for h in (logging.FileHandler(logfile, encoding="utf-8"), logging.StreamHandler(sys.stdout)):
        h.setFormatter(fmt)
        log.addHandler(h)
    return logfile


def norm_pw(pw: str) -> bytes:
    """Normaliseer de wachtzin: kleine letters, zonder spaties (identiek aan de app)."""
    return re.sub(r"\s+", "", pw.lower()).encode("utf-8")


# ---------------------------------------------------------------- controle
def validate(data: dict) -> list:
    """Controleer de gegevens en geef een lijst waarschuwingen terug.

    Harde fouten (ontbrekende velden, ongeldige datums) geven een exception.
    """
    kids = set(data.get("kids", []))
    warnings = []
    for i, e in enumerate(data["events"]):
        where = f"activiteit {i + 1} ({e.get('d', '?')})"
        for f in ("d", "type", "wat", "tijd"):
            if not e.get(f):
                raise ValueError(f"{where}: veld '{f}' ontbreekt")
        dt.date.fromisoformat(e["d"])  # ongeldige datum -> ValueError
        if e["type"] not in ("training", "veld", "zaal", "zaalleiding", "keepers", "elders"):
            raise ValueError(f"{where}: onbekend type '{e['type']}'")
        # alle genoemde namen moeten in de teamlijst staan
        named = [e.get("keeper"), e.get("captain"), e.get("fruit")]
        named += e.get("rust", []) + e.get("afwezig", [])
        named += e["rijden"] if isinstance(e.get("rijden"), list) else []
        named += e.get("kids", [])
        for n in filter(None, named):
            if n not in kids:
                warnings.append(f"{where}: '{n}' staat niet in de teamlijst")
        # wie rust of afwezig is, hoort geen keeper/captain/fruit te zijn
        off = set(e.get("rust", [])) | set(e.get("afwezig", []))
        for role in ("keeper", "captain", "fruit"):
            if e.get(role) in off:
                warnings.append(f"{where}: {e[role]} is {role} maar ook rust/afwezig")
        # rijders die zelf niet spelen (afwezig) is waarschijnlijk een vergissing
        if isinstance(e.get("rijden"), list):
            for n in set(e["rijden"]) & set(e.get("afwezig", [])):
                warnings.append(f"{where}: ouders van {n} rijden, maar {n} is afwezig")
    return warnings


# ---------------------------------------------------------------- versleutelen
def encrypt(data: dict, password: str) -> dict:
    """Versleutel de JSON met AES-256-GCM; sleutel via PBKDF2-SHA256."""
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(hashes.SHA256(), 32, salt, PBKDF2_ITER).derive(norm_pw(password))
    ct = AESGCM(key).encrypt(iv, json.dumps(data, ensure_ascii=False).encode("utf-8"), None)
    b64 = lambda x: base64.b64encode(x).decode()
    return {"salt": b64(salt), "iv": b64(iv), "iter": PBKDF2_ITER, "ct": b64(ct)}


# ---------------------------------------------------------------- agenda (zonder namen)
def times(text: str) -> list:
    """Alle tijden (uu:mm) in een tekst als (uur, minuut)."""
    return [tuple(map(int, t.split(":"))) for t in re.findall(r"\d{1,2}:\d{2}", text or "")]


def span(e: dict):
    """Begin- en eindtijd voor de agenda: vanaf verzamelen, of 15 min voor een training."""
    day = dt.date.fromisoformat(e["d"])
    ts, verz = times(e["tijd"]), times(e.get("verz", ""))
    at = lambda hm: dt.datetime.combine(day, dt.time(0, 0)) + dt.timedelta(hours=hm[0], minutes=hm[1])
    if e["type"] in ("training", "keepers"):
        start = at(ts[0]) - dt.timedelta(minutes=15 if e["type"] == "training" else 0)
        end = at(ts[1]) if len(ts) > 1 else at(ts[0]) + dt.timedelta(hours=1)
    else:
        start = at(verz[0]) if verz else at(ts[0])
        end = at(ts[-1]) + dt.timedelta(minutes=80 if e["type"] == "veld" else 40)
    return start, end


def ics_escape(s: str) -> str:
    """Escape tekst volgens RFC 5545."""
    return s.replace("\\", "\\\\").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;")


def build_ics(data: dict, team_name: str) -> str:
    """Teamagenda zonder namen van kinderen: alleen wat, wanneer, waar en verzamelen."""
    f = lambda d: d.strftime("%Y%m%dT%H%M%S")
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = ["BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:-//shintywebapp//{VERSION}//NL",
           "CALSCALE:GREGORIAN", "METHOD:PUBLISH", f"X-WR-CALNAME:{ics_escape(team_name)}",
           "X-WR-TIMEZONE:Europe/Amsterdam", "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
           "X-PUBLISHED-TTL:PT6H"]
    for e in data["events"]:
        if e["type"] == "elders":   # wedstrijden van een ander team horen niet in de teamagenda
            continue
        s, en = span(e)
        title = re.sub(r"^(Veld|Zaal[^:]*): ", "", e["wat"])
        desc = [f"Tijd: {e['tijd']}"]
        if e.get("verz"):
            desc.append(f"Verzamelen: {e['verz']}")
        desc.append("Taken (keeper, rijden, fruit) staan in de team-app.")
        out += ["BEGIN:VEVENT", f"UID:{e['d']}-{e['type']}-{hashlib.sha1(e['wat'].encode()).hexdigest()[:10]}@shintywebapp",
                f"DTSTAMP:{now}", f"DTSTART;TZID=Europe/Amsterdam:{f(s)}", f"DTEND;TZID=Europe/Amsterdam:{f(en)}",
                f"SUMMARY:{ics_escape(team_name.split()[-1] + ': ' + title)}",
                f"LOCATION:{ics_escape(e['waar'])}", f"DESCRIPTION:{ics_escape(chr(10).join(desc))}", "END:VEVENT"]
    out.append("END:VCALENDAR")
    return "\r\n".join(out) + "\r\n"


# ---------------------------------------------------------------- hoofdprogramma
def main(argv=None) -> int:
    """Lees, controleer, versleutel en schrijf de bestanden voor één team."""
    args = parse_args(argv)
    inp = Path(args.input).resolve()
    logfile = setup_logging(inp, args.team)
    log.info("%s v%s (%s) — team %s", VERSION_NAME, VERSION, VERSION_DATE, args.team)

    password = os.environ.get(args.password_env)
    if not password:
        log.error("Omgevingsvariabele %s met de wachtzin ontbreekt", args.password_env)
        return 2

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    team = next((t for t in cfg["teams"] if t["id"] == args.team), None)
    if not team:
        log.error("Team %s staat niet in %s", args.team, args.config)
        return 2

    data = json.loads(inp.read_text(encoding="utf-8"))
    warnings = validate(data)
    for w in warnings:
        log.warning(w)
    if warnings and args.strict:
        log.error("%d waarschuwing(en) en --strict: niets geschreven", len(warnings))
        return 1

    # 0) ongewijzigd? Vingerafdruk (HMAC met de wachtzin, zonder het tijdstip) vergelijken
    out_html = Path(args.outdir) / args.team / "index.html"
    out_ics = Path(args.outdir) / "agenda" / f"{team['feed_token']}.ics"
    stable = {k: v for k, v in data.items() if k != "updated"}
    digest = hmac.new(norm_pw(password), json.dumps(stable, sort_keys=True, ensure_ascii=False).encode("utf-8"),
                      hashlib.sha256).hexdigest()[:32]
    unchanged = out_html.exists() and out_ics.exists() and f'content="{digest}"' in out_html.read_text(encoding="utf-8")
    if unchanged:
        log.info("Gegevens ongewijzigd: %s niet opnieuw geschreven", out_html.relative_to(ROOT))

    # 1) versleutelde app
    if not unchanged:
        feed_rel = f"../agenda/{team['feed_token']}.ics"
        html = Path(args.template).read_text(encoding="utf-8")
        vault = json.dumps(encrypt(data, password))
        cfg_js = json.dumps({"feed": feed_rel, "team": team["name"]}).replace("<", "\\u003c")
        html = html.replace("__VAULT__", vault).replace("__CFG__", cfg_js)
        html = html.replace('<meta name="robots"', f'<meta name="build" content="{digest}">\n<meta name="robots"', 1)
        out_html.parent.mkdir(parents=True, exist_ok=True)
        out_html.write_text(html, encoding="utf-8")

        # 2) teamagenda zonder namen
        out_ics.parent.mkdir(parents=True, exist_ok=True)
        out_ics.write_text(build_ics(data, team["name"]), encoding="utf-8")

    # 3) controle: er mag geen enkele naam leesbaar in de uitvoer staan
    leaked = [k for k in data.get("kids", []) for p in (out_html, out_ics)
              if re.search(rf"\b{re.escape(k)}\b", p.read_text(encoding="utf-8"))]
    if leaked:
        log.error("Namen leesbaar in de uitvoer: %s — bestanden verwijderd", sorted(set(leaked)))
        out_html.unlink(); out_ics.unlink()
        return 1

    # 4) invoerscherm voor trainers en teammanagers, met het adres van de back-end
    beheer_tpl = ROOT / "template" / "beheer.html"
    if beheer_tpl.exists():
        url = os.environ.get("SHEET_API_URL") or cfg.get("backend_url", "")
        out_beheer = Path(args.outdir) / "beheer" / "index.html"
        out_beheer.parent.mkdir(parents=True, exist_ok=True)
        out_beheer.write_text(beheer_tpl.read_text(encoding="utf-8").replace("__API_URL__", url), encoding="utf-8")
        log.info("Geschreven: %s (%s)", out_beheer.relative_to(ROOT), "gekoppeld" if url.startswith("https://") else "demomodus")

    log.info("Geschreven: %s (%d activiteiten, versleuteld)", out_html.relative_to(ROOT), len(data["events"]))
    log.info("Geschreven: %s (teamagenda, zonder namen)", out_ics.relative_to(ROOT))
    log.info("Log: %s", logfile)
    return 0


if __name__ == "__main__":
    sys.exit(main())
