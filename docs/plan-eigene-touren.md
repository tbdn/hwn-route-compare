# Plan: Routenvorschläge und eigene Touren

Stand: 05.10.2026

## Status

| Schritt | Inhalt | Status |
|---|---|---|
| – | Niveau-Berechnung aus aktuellen Werten | ✅ erledigt (05.10.2026) |
| 1 | Fortschritt pro Stempel, Kennzeichnung als Vorschlag | ✅ erledigt (05.10.2026) |
| 1b | Teilvorschläge für lange Touren | ✅ erledigt (05.10.2026) |
| 2 | Eigene Touren | ✅ erledigt (05.10.2026) |
| 3 | Vorschläge passen sich an | ✅ erledigt (05.10.2026) |
| 4 | Routenabgleich anbinden | ✅ erledigt (05.10.2026) |
| 5 | Eigene Tour auf der Karte zusammenstellen (optional) | ⬜ offen, nächster Schritt |

Die automatisierten Tests zu den erledigten Schritten liegen in `tests/` (`npm install`, dann `npm test`), siehe Abschnitt „Tests“ in `CLAUDE.md`.

## Ziel

- Die Touren aus `tours.json` und die Tracks in `src/data/tours/` sind **Vorschläge**. Das muss in der App klar erkennbar sein.
- Man kann **eigene Touren** anlegen, mit beliebigen Stempeln, z. B. nur 129 und 130.
- Der Fortschritt stimmt immer. Gesammelt ist, wo man wirklich war, und die Vorschläge passen sich an das an, was schon erledigt oder anders geplant ist.

## Ausgangslage (vor Schritt 1)

- Der Fortschritt hängt an **Touren**:
  - Erledigte Touren stehen in `hwn-tours-done`.
  - Gesammelte Stempel werden daraus abgeleitet (`collectedStamps()` in `tourplan.js`).
  - `hwn-stamps-extra` füllt sich nur über einen Import. Einzelne Stempel lassen sich in der Oberfläche nicht abhaken.
- Tracks hängen an Tour-IDs. Gespeichert sind sie in IndexedDB (`hwn-route-compare` / `tour-gpx`, Schlüssel = Tour-ID) oder als `src/data/tours/<ID>.gpx`.
- Die Projekt-Tracks sind von OpenRouteService berechnet, heißen in der App aber „Geplanter Track“.

**Beispiel: eigene Route über 129 und 130.** Beide Stempel gehören zum Vorschlag A1 (129, 130, 105, 113).
- Lädt man die Route bei A1 hoch, ersetzt sie den Vorschlag, und es erscheint die Warnung „Nicht am Track: 105, 113“.
- „km offen“ ist danach zu niedrig, weil 105 und 113 nicht mehr mitgezählt werden.
- Ein Haken bei A1 markiert alle vier Stempel als gesammelt, das ist falsch. Ohne Haken zählt gar nichts.

## Zielbild

### Begriffe

| Begriff | Bedeutung |
|---|---|
| **Vorschlag** | Tour aus `tours.json` (A1 … H3), optional mit Routenvorschlag-Track aus `src/data/tours/` |
| **Eigene Tour** | Vom Nutzer angelegt: Name, GPX, erkannte Stempel, Status, optional Komoot-Link |
| **Gesammelt** | Stempel, der abgehakt ist. Das ist die einzige Quelle für den Fortschritt. |
| **Verplant** | Offener Stempel, der in einer geplanten eigenen Tour liegt |

### Regeln

1. **Der Fortschritt hängt an Stempeln.**
   - Gespeichert wird nur die Menge der gesammelten Stempel.
   - Ein Vorschlag gilt als erledigt, wenn alle seine Stempel gesammelt sind.
   - Der Haken an einem Vorschlag oder einer eigenen Tour sammelt alle ihre Stempel. Nimmt man ihn heraus, werden genau diese Stempel wieder entfernt.
   - Einzelne Stempel lassen sich direkt abhaken.
2. **Eigene Touren gehen vor.**
   - Ein offener Stempel, der in einer geplanten eigenen Tour liegt, zählt für den Vorschlag als „verplant“.
   - Der Vorschlag behält dann nur noch seinen **Rest**: Stempel, die weder gesammelt noch verplant sind.
3. **Ein Track ändert nie den Fortschritt.** Das gilt wie bisher, und zwar für Vorschläge und eigene Touren.
4. **Jeder offene Stempel zählt genau einmal in „km/Hm offen“:**
   - geplante eigene Touren mit ihren Track-Werten,
   - plus der Rest der Vorschläge.
   - Für einen Rest-Vorschlag gilt:
     - Ist er unverändert, zählen seine Track-Werte.
     - Ist er verkleinert, zählt eine Schätzung für die Restrunde, gekennzeichnet mit „~“ / „≥“.
     - Hat er keinen Rest mehr, zählt er 0.

### Beispiel 129 und 130 im Zielbild

1. Eigene Tour „Meine Runde“ per GPX anlegen. Die App erkennt 129 und 130 automatisch.
2. A1 zeigt jetzt: „129, 130 in eigener Tour ‚Meine Runde‘ verplant · Rest: 105, 113 (~x km, geschätzt)“. Dazu gibt es den Button „Rest auf Wanderwege legen“.
3. Nach der Wanderung hakt man „Meine Runde“ ab. 129 und 130 sind gesammelt, auf der Karte grau. „km/Hm zurückgelegt“ kommt aus dem Track der eigenen Tour.
4. A1 zeigt „2 von 4 Stempeln offen“. „km offen“ enthält nur die Restrunde.

## ✅ Niveau-Berechnung (umgesetzt am 05.10.2026, gilt für alle künftigen Touren)

Das Niveau ist kein gespeicherter Wert mehr. `tours.json` hat kein Feld `level`. Die App berechnet es mit `tourLevel()` in `tourplan.js` aus den aktuellen Werten (`tourFigures()`):

- **Leistungs-km** = km + Hm / 100.
- **Mit echten Höhenmetern** (GPX-Track mit `<ele>`):
  - leicht: unter 25 Leistungs-km
  - mittel: ab 25
  - anspruchsvoll: ab 32
- **Mit geschätzten Höhenmetern** (Luftlinie × 1,4, Hm nur von Stempel zu Stempel, angezeigt als „~leicht“ usw.):
  - leicht: unter 21
  - mittel: ab 21 oder höchster Punkt ab 650 m
  - anspruchsvoll: ab 26,5
  - Das ist genau die ursprüngliche Regel des Tourenplans. Für alle Touren ohne Track ergibt sie die alten Werte.
- **Höhenregel für beide:** Ein höchster Punkt ab 850 m (Brockengebiet) ergibt immer „anspruchsvoll“.
- Der Tooltip am Niveau zeigt die Leistungs-km und die Quelle (Track oder Schätzung).
- Einzelstempel ohne Runde (G1) haben kein Niveau.

**Warum zwei Schwellen:** Die echten Hm aus den Tracks sind im Schnitt etwa sechsmal so hoch wie die Schätzung. Mit den alten Schwellen wären 24 von 49 Runden „anspruchsvoll“ gewesen.

**Stand mit den aktuellen Routen:** 20 leicht, 19 mittel, 10 anspruchsvoll (vorher aus der Schätzung: 21 / 23 / 5).

**Für die Zukunft:**
- Eigene Touren (Schritt 2) und Rest-Runden (Schritt 3) bekommen ihr Niveau über dieselbe Funktion. `tourLevel()` wird dafür so verallgemeinert, dass sie km, Hm, höchsten Punkt und die Angabe „echt/geschätzt“ entgegennimmt statt einer Tour aus `tours.json`.
- Für die Rest-Schätzung gelten die Schätz-Schwellen.
- Die Schwellen stehen zentral in `LEVEL_RULES`. Sobald einige Touren tatsächlich gelaufen sind, sollten sie mit dem eigenen Empfinden abgeglichen werden.
- Die ORS-Höhendaten sind grob, und einige ORS-Tracks enthalten Umwege (A5, B3, C5, D7). Nach dem Feinschliff in Komoot ändern sich km, Hm und damit das Niveau automatisch.

**Saison-Tags:** werden seit Schritt 1 ebenfalls in der App aus dem höchsten Punkt berechnet (unter 600 m ganzjährig, unter 800 m Apr–Nov, darüber Mai–Okt).

## Umsetzung in Schritten

Jeder Schritt ist für sich nutzbar und testbar.

### ✅ Schritt 1: Fortschritt pro Stempel und Kennzeichnung als Vorschlag

**Status: umgesetzt am 05.10.2026.** Abweichungen von der ursprünglichen Planung:
- Die Rückfrage beim Entfernen des Hakens ist entfallen. Jeder Stempel gehört zu genau einem Vorschlag, der Haken kann also keine Stempel anderer Touren entfernen.
- Den Button im Karten-Popup gibt es nicht. Ein Klick auf einen Stempel wählt den Vorschlag aus, die Haken pro Stempel stehen in der Stempelliste im Detail.
- Die Saison-Tags werden jetzt aus dem höchsten Punkt berechnet (`SEASON_TAGS`). In `tours.json` stehen nur noch die thematischen Hinweise (Herbst, Frühjahr, früh starten).
- Statistik: „Touren erledigt“ heißt jetzt „Vorschläge erledigt“.

**Fortschritt und Speicher**
- Neuer Speicher-Schlüssel `hwn-stamps-collected` als einzige Quelle.
- Migration beim ersten Start: Stempel aller Touren aus `hwn-tours-done` plus `hwn-stamps-extra` übernehmen. Die alten Schlüssel bleiben zur Sicherheit stehen und werden nicht mehr geschrieben.
- `isDone(tour)` wird abgeleitet: Alle Stempel der Tour sind gesammelt.

**Bedienung**
- Der Tour-Haken (Liste und Detail) setzt oder entfernt alle Stempel der Tour.
  - Teilweise gesammelte Touren zeigen den Haken als „teilweise“ (`indeterminate`) und „2/4“.
  - Beim Entfernen des Hakens fragt die App kurz nach, wenn dabei auch Stempel entfernt würden, die zu einer anderen erledigten Tour gehören.
- Im Detail ist jeder Stempel der Liste einzeln abhakbar. Im Karten-Popup eines Stempels gibt es einen Button „gestempelt / nicht gestempelt“.

**Statistik**
- „Touren erledigt“ zählt vollständig gesammelte Vorschläge.
- „km/Hm zurückgelegt“ zählt in Schritt 1 die vollständig erledigten Vorschläge, wie bisher.

**Texte**
- Überschrift und Liste: „Tourvorschläge“. In Liste und Detail heißen Touren „Vorschlag A1“.
- Projekt-Track: „Routenvorschlag (OpenRouteService, ungeprüft)“ statt „Geplanter Track“.
  - Ein Komoot-Track im Projekt (B7, B8, D8) heißt „Track aus dem Projekt“.
  - Unterscheidung über `creator` / `<name>` im GPX: enthält er „OpenRouteService“, gilt er als Vorschlag.
- Hinweis im Detail: „Vorschlag. Du kannst ihn übernehmen, anpassen oder eine eigene Tour anlegen.“
- Abschnitt „So ist der Plan entstanden“ und `CLAUDE.md` anpassen.

**Export/Import (v3)**
- `stamps` ist jetzt maßgeblich.
- `doneTours` wird weiter geschrieben, damit ältere App-Stände die Datei lesen können.
- Beim Import von v1/v2 gilt: `stamps` ∪ Stempel aus `doneTours`.

**Dateien:** `src/components/tourplan.js`, `src/index.html`, `src/main.css`, `CLAUDE.md`

**Tests:**
- Migration aus einem alten Speicherstand.
- Einzelstempel abhaken.
- Teilweise erledigte Tour, Tour-Haken setzen und entfernen.
- Import einer v2-Datei (`draft/hwn-fortschritt.json`), Export v3.

### ✅ Schritt 1b: Teilvorschläge für lange Touren

**Status: umgesetzt am 05.10.2026.**
- `scripts/suggest-tour-parts.js` hat die Teilungen berechnet und mit `--write` in `tours.json` geschrieben. Geteilt sind **A2, A5, B4, D2, D7, E3 und G2**, je in Teil a und b.
- Die Platzhalter liegen in `draft/tours/<ID>a.gpx` / `<ID>b.gpx`.
- Die Teile haben noch **keine Tracks**. Ihre Werte sind geschätzt („~“, „≥“), deshalb zeigt „km offen“ ein „~“, sobald ein Teil ohne Track gezählt wird. Nächster Handgriff: Für jeden Teil „Auf Wanderwege legen“ ausführen oder einen Komoot-Track als `src/data/tours/<ID>a.gpx` ablegen.

Abweichungen von der ursprünglichen Planung:
- Die Kriterien im Skript sind gegenüber dem Entwurf angepasst:
  - Ein Teil darf kürzer als 5 km sein, wenn er mindestens 3 km vom anderen Teil entfernt in einem eigenen Gebiet liegt.
  - Dadurch kommen A5 (Goslar-Teil) und B4 (18, 156) dazu.
  - B2 fällt wegen 5 km Mehrweg heraus.
  - B3 ist ausdrücklich ausgenommen (`NO_SPLIT`, Brockenbahn).
- Die Teile sind auf der Karte nicht über die Strichart unterscheidbar, denn gestrichelt bedeutet schon „erledigt“. Stattdessen wird Teil b in einer helleren Regionsfarbe gezeichnet, und die Stempelnummern auf der Karte tragen den Teil-Buchstaben (a1, a2, b1, …).
- Die Teil-Zeilen stehen in der Liste immer unter ihrem Vorschlag. Die Kennzahlen der nicht gewählten Variante sind blass.
- Wählt man einen Teil aus (Liste, Karte, Detail), wechselt der Vorschlag automatisch auf „In zwei Teilen“.

**Ursprüngliche Planung:**

**Ziel:** Lange Vorschläge lassen sich wahlweise komplett oder in zwei Teilen gehen. Der Vorschlag bleibt bestehen, die Teile sind eine Variante.

**Voraussetzung:** Schritt 1 (Fortschritt pro Stempel). Erst dann zählt ein gelaufener Teil korrekt, und der Vorschlag ist erledigt, sobald beide Teile gelaufen sind.

**Daten:** Feld `parts` in `tours.json`, z. B.

```json
"parts": [
  {"id": "A5a", "name": "Okertal", "stamps": [117, 118, 116, 119]},
  {"id": "A5b", "name": "Goslar", "stamps": [91, 114]}
]
```

- Jeder Teil ist eine geschlossene Runde mit eigener Stempel-Reihenfolge.
- Tracks liegen wie bei Vorschlägen als `src/data/tours/A5a.gpx`, alternativ als Upload im Browser oder berechnet über „Auf Wanderwege legen“.
- Die Kennzahlen jedes Teils (km, Hm, Niveau) kommen aus dem Track oder aus der Schätzung, wie beim Vorschlag.

**Auswahl, welche Touren geteilt werden:** Ein Skript `scripts/suggest-tour-parts.js` (analog `generate-tour-drafts.js`) berechnet die Teilungen.
- Kandidaten sind alle Vorschläge ab 30 Leistungs-km.
- Gesucht wird die beste Teilung der Stempelreihenfolge in zwei zusammenhängende Gruppen. Ziel ist eine möglichst kurze längere Hälfte bei wenig Mehrweg.
- Aufgenommen wird eine Teilung nur, wenn jeder Teil mindestens 2 Stempel und rund 8 km hat und der Mehrweg höchstens ~3 km beträgt.
- Das Skript schreibt `parts` in `tours.json` und die Platzhalter-GPX nach `draft/tours/<ID>a.gpx` / `<ID>b.gpx`.
- Ergebnis des Skripts vom 05.10.2026. Die km sind geschätzt und auf den Track-Faktor der Tour hochgerechnet; „Abstand“ ist die kürzeste Entfernung zwischen den beiden Teilen.

| Tour | Teil a | Teil b | Mehrweg | Abstand | Ergebnis |
|---|---|---|---|---|---|
| A2 | 142, 106, 107 (~11,9 km) | 103, 104, 102 (~14,0 km) | 2,4 km | 2,3 km | geteilt |
| A5 | 117, 118, 116, 119 Okertal (~10,2 km) | 91, 114 Goslar (~2,2 km) | −13,7 km | 4,0 km | geteilt (eigene Gebiete) |
| B4 | 22, 15, 17, 13 (~13,5 km) | 18, 156 (~3,2 km) | −6,2 km | 3,4 km | geteilt (eigene Gebiete) |
| D2 | 33, 32, 31 (~10,3 km) | 35, 36, 34 (~9,7 km) | −1,4 km | 2,2 km | geteilt |
| D7 | 64, 63, 62, 65 (~14,4 km) | 70, 68, 67, 69, 66 (~16,2 km) | −1,9 km | 1,4 km | geteilt |
| E3 | 162, 163, 160 (~10,5 km) | 58, 165, 90, 164 (~9,4 km) | −1,9 km | 1,4 km | geteilt |
| G2 | 99, 98, 218 (~11,6 km) | 92, 93, 95 (~10,7 km) | −1,2 km | 2,2 km | geteilt |
| B2 | 169, 1, 2, 3 (~15,5 km) | 4, 170, 122, 121 (~14,9 km) | 5,2 km | 1,8 km | nicht geteilt (Mehrweg) |
| C4 | 151, 101 (~2,2 km) | 150, 115, 152 (~13,4 km) | −4,9 km | 2,8 km | nicht geteilt (Mini-Teil ohne eigenes Gebiet) |

- Ein negativer Mehrweg heißt: Die beiden Runden sind zusammen kürzer als die ganze Tour, dafür fährt man zwischen ihnen mit dem Auto.

**Nicht teilen:**
- C5 (2 Stempel) und C7 (3 Stempel mit 6 bis 7 km Abstand): in Komoot prüfen.
- B3 (Brocken): eher als Streckenwanderung mit der Brockenbahn.
- ~~B4: 18 und 156 besser als Abstecher mit dem Auto.~~ Inzwischen doch geteilt: Der kurze Teil liegt 3,4 km entfernt in einem eigenen Gebiet.

**Erst prüfen:** Bei D7, A5, C5, B3 und B2 ist der ORS-Track 1,3- bis 1,6-mal so lang wie die Schätzung. Das deutet auf Umwege hin. Diese Touren vor dem Teilen in Komoot prüfen.

**Anzeige:**
- Im Detail eines Vorschlags mit `parts` gibt es den Umschalter „Komplett“ / „In zwei Teilen“.
- In der Ansicht „In zwei Teilen“ werden beide Teile auf der Karte in der Regionsfarbe gezeichnet, unterscheidbar durch die Strichart. Jeder Teil hat eigene Kennzahlen, einen Haken (sammelt seine Stempel), GPX-Download, Track-Upload und „Auf Wanderwege legen“.
- In der Liste steht unter dem Vorschlag eine eingerückte Zeile pro Teil.
- In „km/Hm offen“ zählt je Vorschlag die gewählte Variante. Standard ist „Komplett“, die Wahl wird im Browser gespeichert und exportiert.

**Tests:**
- Das Skript liefert für A5 und D7 die Teilung aus der Tabelle.
- Den Teil A5b abhaken: A5 steht auf 2/6, und erst mit A5a ist A5 erledigt.
- „km offen“ zählt die gewählte Variante, nicht beide.

### ✅ Schritt 2: Eigene Touren

**Status: umgesetzt am 05.10.2026.**

**Bedienung**
- Der Button „+ Eigene Tour aus GPX“ steht über den Region-Chips.
- Nach der Dateiauswahl öffnet sich im Detail-Panel ein Formular. Die Karte zeigt dabei den Track gepunktet als Vorschau.
- Im Formular stehen der Name (aus dem GPX `<name>` oder dem Dateinamen, Komoot-Präfix entfernt) und die erkannten Stempel mit Abstand zum Track und zugehörigem Vorschlag. Stempel lassen sich abwählen oder per Nummer hinzufügen. Dazu kommt „Schon gelaufen“ und „Speichern“.
- Eigene Touren stehen in einer eigenen Liste über den Regionen und haben einen Chip „Eigene Touren“ sowie eine eigene Farbe (`OWN_COLOR`).
- Das Detail einer eigenen Tour bietet: Kennzahlen aus dem Track, Niveau, Saison, Stempelliste mit Haken, „Gelaufen“, „Bearbeiten“ (Name, Stempel, andere GPX-Datei), „Löschen“ mit Rückfrage im Panel, Komoot, GPX-Download und „Im Routenabgleich prüfen“.

**Abweichungen von der ursprünglichen Planung**
- **Stempel-Erkennung:** Sie läuft über die neue Funktion `stampsAlongTrack()` in `tracks.js` statt über `findNearbyStamps`. Die liefert zusätzlich die Position am Track, und die Stempelliste steht dadurch in Laufrichtung.
- **Komoot-Links** eigener Touren liegen wie bei Vorschlägen in `hwn-komoot-links`, mit der ID der eigenen Tour als Schlüssel, nicht im Datensatz selbst.
- **Status:** Er wird nur im Detail über „Gelaufen“ geändert, im Bearbeiten-Formular nur beim Anlegen.
- **Gelaufen entfernen:** Nimmt man „Gelaufen“ heraus, verschwinden die Stempel der Tour wieder, außer eine andere gelaufene eigene Tour enthält sie.
- **Löschen:** Die gesammelten Stempel bleiben erhalten.
- **Offene Frage 2 entschieden:** Entfernt man einzelne Stempel, bleibt die Tour „gelaufen“.
- **Offene Frage 1, Übergangslösung bis Schritt 3:**
  - „km/Hm zurückgelegt“ = gelaufene eigene Touren + erledigte Vorschläge, die **keinen** Stempel mit einer gelaufenen eigenen Tour teilen. Dadurch wird nichts doppelt gezählt.
  - Einen Vorschlag, der teils über eine eigene Tour und teils über seinen eigenen Haken erledigt wurde, zählt die Statistik nur mit der eigenen Tour. Den Rest schätzt erst Schritt 3.
  - „km/Hm offen“ zählt weiter die offenen Vorschläge. Geplante eigene Touren kommen erst mit Schritt 3 dazu, damit Stempel dort nicht doppelt zählen.
- **Neue Statistik** „Eigene Touren gelaufen“ (x/y), nur sichtbar, wenn es eigene Touren gibt.

**Ursprüngliche Planung:**

**Datenmodell**

```js
{
  id: "own-<zeitstempel>",
  name: "Meine Runde",
  gpx: "<gpx …>",
  stamps: [129, 130],            // erkannt, vom Nutzer korrigierbar
  status: "planned" | "walked",
  komoot: [{url, name}],
  createdAt: "…"
}
```

**Speicher**
- IndexedDB `hwn-route-compare`, neuer Store `own-tours`. Dafür steigt die DB-Version auf 2 (`onupgradeneeded` legt nur fehlende Stores an).
- Neue Funktionen in `src/utils/tracks.js`, z. B. `loadOwnTours` / `saveOwnTour` / `deleteOwnTour`.

**Stempel-Erkennung**
- Alle Stempel mit Abstand ≤ `STAMP_ON_TRACK_METERS` (150 m) zum Track.
- Dazu wird `findNearbyStamps` aus `geo.js` wiederverwendet.
- Im Formular ist die erkannte Liste korrigierbar: Haken entfernen, oder einen Stempel per Nummer hinzufügen, wenn er knapp daneben liegt.

**Anlegen**
- Im Tourenplan gibt es den Button „Eigene Tour hinzufügen“. Er führt zu GPX-Auswahl, Name (Vorschlag aus GPX `<name>` oder Dateiname), erkannten Stempeln und dem Button „Speichern“.
- Bei einem Komoot-Dateinamen wird der Komoot-Link automatisch gesetzt, wie heute bei Vorschlägen.

**Anzeige**
- Eigene Abteilung „Eigene Touren“ über den Vorschlägen. Sie bekommt eine eigene Farbe, z. B. dunkles Violett, und einen eigenen Region-Chip „Eigene“.
- Das Detail funktioniert wie bei einem Vorschlag: Karte, Start/Ziel, km/Hm, Stempelliste, Komoot, GPX herunterladen, „Im Routenabgleich prüfen“. Zusätzlich gibt es „Umbenennen“ und „Löschen“, mit Bestätigung im Panel statt `confirm()`.
- Haken „gelaufen“: Er setzt `status: "walked"` und sammelt die Stempel der Tour (Regel 1).

**Export/Import**
- Feld `ownTours` im Export (v3).
- Beim Import gilt dasselbe Verhalten wie für `tracks`: Fehlt das Feld, bleiben die Touren im Browser erhalten.

**Statistik:** „km/Hm zurückgelegt“ = gelaufene eigene Touren + erledigte Vorschläge, ohne doppelt gezählte Stempel (siehe offene Fragen).

**Dateien:** `tourplan.js`, `tracks.js`, `index.html`, `main.css`, `CLAUDE.md`

**Tests:**
- GPX mit 129 und 130 anlegen, die Erkennung muss genau [129, 130] liefern.
- Speichern, neu laden, exportieren und importieren.
- Haken setzen: Die Stempel sind gesammelt, A1 steht auf 2/4.

### ✅ Schritt 3: Vorschläge passen sich an

**Status: umgesetzt am 05.10.2026.**

**Umgesetzt**
- **Rest:** `restStamps()` liefert die Stempel, die weder gesammelt noch in einer geplanten eigenen Tour verplant sind (`plannedStampOwners()`). `restFigures()` berechnet die Kennzahlen dazu: unverändert → Track bzw. Schätzung, verkleinert → `estimateLoop()`, leer → 0.
- **Detail:** Die Box „Stand dieses Vorschlags“ zeigt, was gesammelt ist, was in welcher eigenen Tour verplant ist (mit Link zu der Tour) und was übrig bleibt, samt geschätzten km, Hm und Niveau.
- **Buttons:** „Rest auf Wanderwege legen“ erscheint ab 2 Rest-Stempeln und legt eine geplante eigene Tour „A1 – Rest“ an. „Als eigene Tour übernehmen“ steht in der Track-Box.
- **Karte:** Ein verkleinerter Vorschlag wird blass gezeichnet, seine Rest-Runde gepunktet in der Regionsfarbe.
- **Liste:** km, Std. und Hm zeigen den Rest mit „~“ und dem Tag „Rest“. Ist nichts mehr übrig, steht dort „–“. In der Stempelfolge sind gesammelte Stempel durchgestrichen, verplante kursiv.
- **Statistik:** „km/Hm offen“ zählt nach Regel 4. Neu ist „davon verplant“ (nur sichtbar, wenn etwas verplant ist).
- Ergebnis für das Beispiel 129/130: Mit geplanter eigener Tour zählt A1 nur noch die Rest-Runde 105/113 (~7,7 km) und die eigene Tour ihren Track. Nach „Rest auf Wanderwege legen“ ist A1 leer, und alles zählt über eigene Touren.

**Abweichungen von der ursprünglichen Planung**
- **Reihenfolge der Rest-Runde:** Sie folgt der Reihenfolge des Vorschlags (verplante und gesammelte Stempel fallen heraus), nicht `optimizeStampOrder`. Die Vorschlagsreihenfolge ist bereits eine optimierte Runde, und `optimizeStampOrder` braucht Positionen entlang einer Route.
- **„Als eigene Tour übernehmen“** gibt es nur für Vorschläge mit Track. Eine Luftlinien-Runde als eigene Tour hätte echte km vorgetäuscht, ohne den Wege-Zuschlag. Komoot-Links des Vorschlags werden mit übernommen.
- **Nur ein Rest-Stempel:** Es gibt keine Rest-Runde, sondern den Hinweis, ihn als Abstecher mitzunehmen.
- **Keine eigene Spalte „Stempel 2/4“:** Der Zähler steht wie seit Schritt 1 unter dem Haken.
- **„km/Hm zurückgelegt“** bleibt bei der Regel aus Schritt 2.

**Ursprüngliche Planung:**

**Rest berechnen**
- `remainingStamps(tour)` = Stempel der Tour, die weder gesammelt noch in einer geplanten eigenen Tour verplant sind.

**Rest-Schätzung**
- Die Reihenfolge kommt aus `optimizeStampOrder` (`optimize.js`).
- Strecke: geschlossene Luftlinie × 1,4, also dieselbe Methode wie in `tours.json`.
- Zeit: 4 km/h + 6 min pro Stempel. Hm: Anstiege von Stempel zu Stempel (≥).

**Anzeige im Detail eines Vorschlags**
- „Gesammelt: 129, 130 · Verplant in ‚Meine Runde‘: … · Rest: 105, 113“.
- Bei vollem Rest bleibt der Track wie bisher, bei verkleinertem Rest wird er gedämpft (gestrichelt/blass) und um die Rest-Luftlinie ergänzt.

**Neue Buttons**
- „Rest auf Wanderwege legen“: berechnet per ORS eine Runde nur über den Rest und speichert sie als neue **eigene Tour** (Status geplant), z. B. „A1 – Rest“. Der Vorschlag selbst bleibt unverändert.
- „Als eigene Tour übernehmen“: kopiert einen Vorschlag samt Track in eine eigene Tour, die man dann anpassen kann.

**Statistik**
- „km/Hm offen“ nach Regel 4.
- „Offene Stempel“ bleibt die Zahl der nicht gesammelten Stempel. Neu ist „davon verplant“.

**Liste:** Spalte „Stempel“ zeigt „2/4“, Rest-km mit „~“.

**Tests:**
- Eigene geplante Tour über 129 und 130: A1-Rest = [105, 113], „km offen“ enthält Rest-Schätzung und eigene Tour, kein Stempel zählt doppelt.
- Rest auf Wanderwege legen, mit nachgebautem ORS.

### ✅ Schritt 4: Routenabgleich anbinden

**Status: umgesetzt am 05.10.2026.**

**Umgesetzt**
- **Nach dem Abgleich:** In der Kopfzeile „Treffer“ steht „Als eigene Tour speichern“. Der Button wechselt zum Tourenplan und öffnet das Formular aus Schritt 2 mit der verglichenen GPX und ihrem Dateinamen bzw. dem Namen aus dem Tourenplan. Vorausgewählt sind die Stempel am Track (≤ 150 m), die Stempel „Direkt an der Route“ und die im Abgleich angehakten Karten.
- **Modal „Erweiterte Route“:** Hier gibt es ebenfalls „Als eigene Tour speichern“. Der Button wird aktiv, sobald die Route berechnet ist, und übergibt den ORS-Track (`coordinatesToGPX`) mit dem Namen „<Route> + n Stempel“. Vorausgewählt sind die hinzugefügten Stempel; was der Track sonst passiert, erkennt das Formular.
- **Offene Frage 5 geklärt und behoben:**
  - Alle ORS-Anfragen laufen jetzt über den GeoJSON-Endpunkt (`requestRoute()` in `routing.js`). Betroffen sind „🥾 Route berechnen“, „Zur Route hinzufügen“ und „Auf Wanderwege legen“.
  - Die Karte bekommt `[lat, lon]`-Punkte, `decodePolyline` ist entfernt.
  - Die Höhenmeter kommen aus der Antwort; fehlen sie dort, werden sie aus den Koordinaten berechnet.
  - Der Routing-Cache heißt jetzt `hwn-routing-cache-v2`. Alte Einträge mit kodierten Linien werden gelöscht.

**Abweichungen von der ursprünglichen Planung**
- **Direkter Aufruf statt Event:** Statt eines Events `hwn:save-own-tour` ruft `app.js` direkt `openOwnTourDraft()` aus `tourplan.js` auf. `app.js` importiert den Tourenplan ohnehin, und so ist sicher, dass er geladen ist, bevor das Formular öffnet.
- **Vorauswahl:** Vorausgewählt sind alle Stempel bis 150 m vom Track plus die übergebenen, nicht nur „Direkt an der Route“ (25 m). Das entspricht dem normalen Anlegen aus Schritt 2.
- **Nicht umgesetzt:** Der Export „Als GPX exportieren“ der Modal liefert weiterhin nur die Stempel als Route, nicht den berechneten Weg. Das war nicht Teil des Schritts; über „Als eigene Tour speichern“ und dann „GPX-Track herunterladen“ bekommt man den Weg.

**Ursprüngliche Planung:**

- Nach dem Abgleich erscheint „Als eigene Tour speichern“. Die erkannten Stempel „Direkt an der Route“ werden vorausgewählt, die aus „In der Nähe“ sind auswählbar.
- Aus der Modal „Erweiterte Route“ heraus gibt es „Als eigene Tour speichern“, mit dem ORS-Track.
- Die Übergabe läuft per Event `hwn:save-own-tour` ({gpx, name, stamps}), analog zu `hwn:compare-route`. Der Tourenplan öffnet dann das Formular aus Schritt 2.

### Schritt 5 (optional): Eigene Tour auf der Karte zusammenstellen

- Modus „Eigene Tour planen“: Stempel auf der Tourenkarte anklicken, die Reihenfolge per `optimizeStampOrder` oder in Klick-Reihenfolge. Danach „Auf Wanderwege legen“ (ORS) oder die Luftlinie speichern.
- Der ORS-Fehler „kein Weg innerhalb von 350 m“ wird mit dem betroffenen Stempel angezeigt.

## Offene Fragen / Entscheidungen

1. **Doppelt gezählte km bei „zurückgelegt“.** *(Übergangslösung mit Schritt 2 umgesetzt, siehe dort. Seit Schritt 3 zählt „offen“ exakt nach Regel 4; „zurückgelegt“ unterschätzt nur noch, wenn ein Vorschlag teils über eine eigene Tour und teils über seinen eigenen Haken erledigt wurde. Der Weg des Rests ist dann unbekannt; empfohlen ist, den Rest als eigene Tour zu planen und abzuhaken.)* Beispiel: Erst wird „Meine Runde“ (129, 130) gelaufen, später der Rest von A1.
   - Vorschlag: „zurückgelegt“ = Summe der Tracks aller gelaufenen eigenen Touren + Track bzw. Schätzung der Vorschläge, die **als Ganzes** abgehakt wurden.
   - Ein Vorschlag, der nur durch eigene Touren und einzelne Haken vollständig wurde, zählt keine km mehr.
   - Dafür braucht es zusätzlich zu den Stempeln die Liste „als Ganzes erledigte Vorschläge“. Sie wird nur für die Statistik verwendet, nicht für den Fortschritt.
2. ✅ **Status einer eigenen Tour beim Entfernen einzelner Stempel.** *(Entschieden mit Schritt 2: bleibt „gelaufen“.)* Wenn man bei einer gelaufenen eigenen Tour später einen Stempel wieder entfernt:
   - Vorschlag: Die Tour bleibt „gelaufen“, es wird nur der Stempel entfernt.
3. **Speicherort eigener Touren im Projekt.** Sollen eigene Touren auch als Dateien im Repo liegen können, z. B. `src/data/own/*.gpx` mit Namen aus dem GPX?
   - Vorschlag: Zunächst nur Browser + Export, später bei Bedarf.
4. **Dateinamen beim Download.** „GPX-Track herunterladen“ speichert `HWN_<ID>.gpx`, das Projekt erwartet `<ID>.gpx`.
   - Vorschlag: Auf `<ID>.gpx` umstellen.
5. ✅ **Bekannter Verdacht im Routenabgleich, nicht geprüft.** *(Mit Schritt 4 behoben: alle Anfragen über den GeoJSON-Endpunkt, siehe dort.)* `decodePolyline` in `map.js` dekodiert 2D, obwohl die ORS-Anfragen `elevation: true` setzen. Das ist vor Schritt 4 zu prüfen, weil die Modal „Erweiterte Route“ dort Tracks liefert.

## Nicht im Umfang

- Neuaufteilung der Vorschläge selbst (die Teilvorschläge aus Schritt 1b ergänzen sie nur).
- Synchronisation zwischen Geräten. Das bleibt bei Export/Import.
- Build-Schritt oder npm-Abhängigkeiten. Es bleibt bei reinen ES-Modulen.
