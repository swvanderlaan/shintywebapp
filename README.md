# Shinty WebApp

Team-app voor ouders van DMHC Shinty: wie doet wat (keeper, captain, fruit, rijden, rust),
het programma en praktische info. De gegevens staan **versleuteld** op GitHub Pages en worden
pas leesbaar na de wachtzin uit de WhatsApp-groep.

## Hoe het werkt

```
Invoerscherm (docs/beheer/)  ->  Apps Script (backend/Code.gs)  ->  Google Sheets
                                                                     |  export (met EXPORT_KEY)
GitHub Action (build.yml): sheet_to_data.py -> data/<team>.json -> build.py
                                                                     |
                     docs/<team>/index.html (versleuteld)  +  docs/agenda/<token>.ics (zonder namen)
```

- **Programma-bestand** (Google Sheet, geen kindernamen): vast rooster, uitzonderingen, keeperstraining,
  wedstrijden, hallen, teams, gebruikers en log. Hierin draait het Apps Script.
- **Taken-bestand per team** (Google Sheet, wel kindernamen): spelers, taken, info, log.
  De link staat in tabblad Teams van het Programma-bestand.

- `docs/` wordt gepubliceerd via GitHub Pages (Settings -> Pages -> branch `main`, map `/docs`).
- `data/` staat in `.gitignore`: leesbare namen komen nooit in deze repository.
- `build.py` controleert na het bouwen dat geen enkele naam uit de teamlijst leesbaar in de uitvoer staat.
- De wachtzin komt uit een omgevingsvariabele; hoofdletters en spaties maken niet uit.

## Back-end installeren (eenmalig)

1. Open het Programma-bestand -> **Extensies -> Apps Script**. Vervang de inhoud van `Code.gs` door
   `backend/Code.gs`. Zet bij Projectinstellingen de tijdzone op *Europe/Amsterdam*.
2. Ververs de Sheet. Kies in het nieuwe menu **Shinty WebApp -> 1. Back-end instellen** en geef toestemming.
   Er komt een tabblad **Gebruikers** bij.
3. Vul in Gebruikers per persoon in: naam, rol (`admin`, `trainer`, `tm`, `keepertrainer`), teams
   (bv. `JO11-1`, of `*` voor alle teams) en een pincode van minstens 6 cijfers.
   Kies **2. Pincodes verwerken**: de pincodes worden versleuteld opgeslagen en uit de Sheet gewist.
4. **Implementeren -> Nieuwe implementatie -> Web-app**. Uitvoeren als: *ik*. Toegang: *iedereen*.
   Kopieer de web-app-URL.
5. Maak op GitHub een fijnmazige token (alleen deze repo, *Actions: read and write*) en zet die via
   **3. GitHub-token instellen**.
6. Zet in GitHub bij Settings -> Secrets and variables -> Actions drie secrets:
   `SHEET_API_URL` (de URL uit stap 4), `EXPORT_KEY` (menu *Exportsleutel tonen*) en `SHINTY_PW` (de wachtzin).
7. Draai de workflow **App bijwerken** één keer met de hand (tab Actions -> Run workflow).

Daarna: elke wijziging via het invoerscherm start binnen ongeveer 5 tot 10 minuten een nieuwe build.
Elke nacht draait de build ook vanzelf. Is er niets veranderd, dan wordt er niets gepubliceerd.

## Invoerscherm

`docs/beheer/` (gemaakt uit `template/beheer.html`). Zonder ingestelde back-end draait het in
**demomodus** met verzonnen namen (pincode `123456`). Rechten:

| Rol | Mag aanpassen |
|---|---|
| trainer | vast rooster, uitzonderingen |
| tm (teammanager) | wedstrijden, taken, spelers, info |
| keepertrainer | keeperstraining |
| admin | alles, alle teams |

Iedereen ziet alle tabbladen van zijn eigen team(s). Na 5 foute pincodes is een naam 15 minuten
geblokkeerd. Elke wijziging komt in het tabblad Log van het betreffende bestand.

## Bijwerken met de hand

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
