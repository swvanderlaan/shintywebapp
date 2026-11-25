# Shinty WebApp

Team-app voor ouders van DMHC Shinty: wie doet wat (keeper, captain, fruit, rijden, rust),
het programma en praktische info. De gegevens staan **versleuteld** op GitHub Pages en worden
pas leesbaar na de wachtzin uit de WhatsApp-groep.

## Hoe het werkt

```
Google Sheet (bron)  ->  data/<team>.json  ->  scripts/build.py  ->  docs/<team>/index.html (versleuteld)
                         (lokaal, niet in git)                        docs/agenda/<token>.ics (zonder namen)
```

- `docs/` wordt gepubliceerd via GitHub Pages (Settings -> Pages -> branch `main`, map `/docs`).
- `data/` staat in `.gitignore`: leesbare namen komen nooit in deze repository.
- `build.py` controleert na het bouwen dat geen enkele naam uit de teamlijst leesbaar in de uitvoer staat.
- De wachtzin komt uit een omgevingsvariabele; hoofdletters en spaties maken niet uit.

## Bijwerken

```bash
pip install cryptography
SHINTY_PW='...' python3 scripts/build.py --input data/jo11-1.json --team jo11-1
git add docs && git commit -m "Update JO11-1" && git push
```

Met `--strict` stopt de build bij waarschuwingen (bv. een keeper die ook als rust staat).

## Beveiliging

- Versleuteling: PBKDF2-SHA256 (310.000 rondes) -> AES-256-GCM in de browser (WebCrypto).
- De pagina is wel openbaar te downloaden; zonder wachtzin is de inhoud onleesbaar.
  Kies daarom een wachtzin van meerdere woorden en wissel hem per seizoen.
- De teamagenda (`.ics`) is niet versleuteld en bevat daarom geen namen; de bestandsnaam is een
  onraadbare token (zie `config/teams.json`).
- `robots.txt` en `noindex` houden zoekmachines buiten de deur.

## Nieuw team toevoegen

1. Voeg het team toe aan `config/teams.json` met een nieuwe `feed_token`
   (`python3 -c "import secrets;print(secrets.token_urlsafe(18))"`).
2. Zet de gegevens in `data/<team>.json` (zelfde opbouw als JO11-1).
3. Bouw met `--team <team>` en voeg een link toe in `docs/index.html`.
