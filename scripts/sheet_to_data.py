#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sheet_to_data.py — zet de export van de back-end (Apps Script) om naar de
gegevens van de team-app (zelfde opbouw als data/jo11-1.json).

Wat het doet
------------
- Vast rooster + uitzonderingen  -> losse trainingen per datum
  (extra = erbij, vervalt = eruit, gewijzigd = vervangt de training van die dag).
- Wedstrijden                    -> veld-, zaal- of zaalleidingwedstrijden.
- Keeperstraining                -> alleen groepen met keepers uit dit team,
                                    met de namen van die keepers.
- Taken (keeper, captain, fruit, rust, afwezig, rijden, zaaldienst) worden op
  datum aan de activiteit gekoppeld. Taken zonder activiteit worden gemeld.

Gebruik
-------
    python3 scripts/sheet_to_data.py --input data/export-jo11-1.json --output data/jo11-1.json

Zonder --output wordt de uitvoer <input>_annotated.json naast de invoer.

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

VERSION_NAME = "Shinty WebApp Sheet-to-data"
VERSION = "1.1.0"
VERSION_DATE = "2026-11-25"

import argparse
import datetime as dt
import json
import logging
import sys
from pathlib import Path

log = logging.getLogger("sheet_to_data")
DAGEN = ["ma", "di", "wo", "do", "vr", "za", "zo"]          # Python: maandag = 0
MAANDEN = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]


def parse_args(argv=None):
    """Lees de commandoregel-argumenten."""
    p = argparse.ArgumentParser(description=f"{VERSION_NAME} v{VERSION} ({VERSION_DATE})")
    p.add_argument("--input", required=True, help="export-JSON van de back-end")
    p.add_argument("--output", help="uitvoer (standaard <input>_annotated.json)")
    p.add_argument("--version", action="version", version=f"{VERSION_NAME} {VERSION} ({VERSION_DATE})")
    return p.parse_args(argv)


def setup_logging(inp: Path) -> Path:
    """Log naar scherm en naar een gedateerd bestand naast de invoer."""
    logfile = inp.parent / f"{dt.date.today().isoformat()}_{inp.stem}_convert.log"
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    log.setLevel(logging.INFO)
    for h in (logging.FileHandler(logfile, encoding="utf-8"), logging.StreamHandler(sys.stdout)):
        h.setFormatter(fmt)
        log.addHandler(h)
    return logfile


def names(text: str) -> list:
    """'A, B , C' -> ['A', 'B', 'C']"""
    return [n.strip() for n in (text or "").split(",") if n.strip()]


def hall_text(code: str, hallen: dict) -> str:
    """Hal-code -> 'Naam, Adres, Plaats' voor de app en de kaartlink."""
    h = hallen.get(code)
    if not h:
        return code
    return ", ".join(x for x in (h.get("naam"), h.get("adres"), h.get("plaats")) if x)


def expand_trainings(rooster: list, uitz: list, hallen: dict) -> list:
    """Vast rooster -> data, daarna uitzonderingen toepassen."""
    by_date = {}
    for r in rooster:
        if r.get("dag") not in DAGEN or not r.get("vanaf") or not r.get("tm"):
            log.warning("Roosterregel overgeslagen (dag of periode ontbreekt): %s", r)
            continue
        day = dt.date.fromisoformat(r["vanaf"])
        end = dt.date.fromisoformat(r["tm"])
        while day <= end:
            if DAGEN[day.weekday()] == r["dag"]:
                by_date.setdefault(day.isoformat(), []).append(r)
            day += dt.timedelta(days=1)
    for u in sorted(uitz, key=lambda x: x.get("datum", "")):
        d = u.get("datum")
        if not d:
            continue
        if u.get("soort") in ("vervalt", "gewijzigd"):
            by_date.pop(d, None)
        if u.get("soort") in ("extra", "gewijzigd"):
            by_date.setdefault(d, []).append(u)
    events = []
    for d, rows in by_date.items():
        for r in rows:
            events.append({"d": d, "type": "training", "wat": "Training",
                           "tijd": f"{r['begin']}–{r['eind']}", "waar": hall_text(r.get("hal", ""), hallen),
                           **({"opm": r["opmerking"]} if r.get("opmerking") else {})})
    return events


def matches(wed: list, hallen: dict) -> list:
    """Wedstrijden -> events (veld, zaal of zaalleiding)."""
    out = []
    for w in wed:
        lead = w.get("zaalleiding") == "ja"
        typ = "zaalleiding" if lead else (w.get("soort") or "zaal")
        prefix = "Zaal (zaalleiding Shinty)" if lead else ("Veld" if typ == "veld" else "Zaal")
        e = {"d": w["datum"], "type": typ, "wat": f"{prefix}: {w.get('wedstrijd', '')}",
             "tijd": w.get("tijd", ""), "waar": hall_text(w.get("hal", ""), hallen)}
        if w.get("verzamelen"):
            e["verz"] = w["verzamelen"]
        if w.get("opmerking"):
            e["opm"] = w["opmerking"]
        out.append(e)
    return out


def keeper_sessions(keepers: list, spelers: list, hallen: dict) -> list:
    """Keeperstraining van groepen waar keepers van dit team in zitten."""
    groups = {}
    for s in spelers:
        if s.get("groep"):
            groups.setdefault(s["groep"], []).append(s["naam"])
    out = []
    for k in keepers:
        kids = groups.get(k.get("groep"))
        if not kids:
            continue
        out.append({"d": k["datum"], "type": "keepers", "wat": f"Keeperstraining ({k['groep']})",
                    "tijd": f"{k['begin']}–{k['eind']}", "waar": hall_text(k.get("hal", ""), hallen), "kids": kids})
    return out


def other_team_matches(wed: list, spelers: list, hallen: dict) -> list:
    """Wedstrijden van een ander team (bv. zaalteam) voor de spelers die daar spelen."""
    out = []
    for w in wed:
        kids = sorted(s["naam"] for s in spelers if s.get("elders") == w.get("team"))
        if not kids:
            continue
        e = {"d": w["datum"], "type": "elders", "team": w["team"], "wat": f"{w['team']}: {w.get('wedstrijd', '')}",
             "tijd": w.get("tijd", ""), "waar": hall_text(w.get("hal", ""), hallen), "kids": kids}
        if w.get("verzamelen"):
            e["verz"] = w["verzamelen"]
        out.append(e)
    return out


def attach_tasks(events: list, taken: list) -> int:
    """Koppel taken op datum aan de activiteit; geeft het aantal niet-gekoppelde taken."""
    unmatched = 0
    for t in taken:
        same_day = [e for e in events if e["d"] == t.get("datum") and e["type"] not in ("keepers", "elders")]
        if len(same_day) > 1:   # meerdere activiteiten: training vs wedstrijd op naam
            want_training = (t.get("activiteit") or "").lower().startswith("training")
            same_day = [e for e in same_day if (e["type"] == "training") == want_training] or same_day
        if not same_day:
            log.warning("Taak zonder activiteit op %s (%s)", t.get("datum"), t.get("activiteit"))
            unmatched += 1
            continue
        e = same_day[0]
        for f in ("keeper", "captain", "fruit"):
            if t.get(f):
                e[f] = t[f]
        for f in ("rust", "afwezig"):
            if names(t.get(f)):
                e[f] = names(t[f])
        rij = (t.get("rijden") or "").strip()
        e["rijden"] = "volgt" if rij in ("", "volgt") else ("eigen" if rij == "eigen gelegenheid" else names(rij))
        if t.get("rijdenOpm"):
            e["rijNote"] = t["rijdenOpm"]
        notes = [x for x in (t.get("zaaldienst"), t.get("opmerking")) if x]
        if notes:
            e["dienst"] = " ".join(notes)
    for e in events:   # activiteiten zonder taken: rijden nog onbekend
        if e["type"] not in ("keepers", "elders"):
            e.setdefault("rijden", "volgt")
    return unmatched


def convert(exp: dict) -> dict:
    """Hele omzetting van export naar app-gegevens."""
    tables = exp["tables"]
    hallen = {h["hal"]: h for h in exp.get("hallen", [])}
    spelers = [s for s in tables.get("spelers", []) if s.get("naam")]
    events = expand_trainings(tables.get("rooster", []), tables.get("uitz", []), hallen)
    events += matches(tables.get("wedstrijden", []), hallen)
    events += keeper_sessions(tables.get("keepers", []), spelers, hallen)
    events += other_team_matches(tables.get("eldersWedstrijden", []), spelers, hallen)
    events.sort(key=lambda e: (e["d"], e["tijd"]))
    unmatched = attach_tasks(events, tables.get("taken", []))
    # opmerking bij training of wedstrijd zonder zaaldienst: toon als notitie
    for e in events:
        opm = e.pop("opm", None)
        if opm and "dienst" not in e:
            e["dienst"] = opm
    stamp = dt.datetime.fromisoformat(exp["exported"]) if exp.get("exported") else dt.datetime.now()
    wd = ["ma", "di", "wo", "do", "vr", "za", "zo"][stamp.weekday()]
    return {
        "updated": f"{wd} {stamp.day} {MAANDEN[stamp.month - 1]} {stamp.year}, {stamp:%H:%M}",
        "team": exp.get("team"),
        "kids": sorted(s["naam"] for s in spelers),
        "elders": {s["naam"]: f"speelt zaal bij {s['elders']}" for s in spelers if s.get("elders")},
        "events": events,
        "info": [[i["kop"], i["tekst"]] for i in tables.get("info", []) if i.get("kop")],
        "_unmatched": unmatched,
    }


def main(argv=None) -> int:
    """Lees de export, zet om en schrijf de app-gegevens."""
    args = parse_args(argv)
    inp = Path(args.input).resolve()
    setup_logging(inp)
    log.info("%s v%s (%s)", VERSION_NAME, VERSION, VERSION_DATE)
    exp = json.loads(inp.read_text(encoding="utf-8"))
    if not exp.get("ok"):
        log.error("Export mislukt: %s", exp.get("error"))
        return 1
    data = convert(exp)
    unmatched = data.pop("_unmatched")
    out = Path(args.output) if args.output else inp.with_name(f"{inp.stem}_annotated.json")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    counts = {t: sum(e["type"] == t for e in data["events"]) for t in ("training", "veld", "zaal", "zaalleiding", "keepers", "elders")}
    log.info("Geschreven: %s — %s, %d spelers, %d taak/taken zonder activiteit",
             out.name, ", ".join(f"{v} {k}" for k, v in counts.items()), len(data["kids"]), unmatched)
    return 0


if __name__ == "__main__":
    sys.exit(main())
