# Plan: Routenvorschläge und eigene Touren

Stand: 05.10.2026

## Ziel

- Die Touren aus `tours.json` und die Tracks in `src/data/tours/` sind **Vorschläge**. Das muss in der App klar erkennbar sein.
- Man kann **eigene Touren** anlegen, mit beliebigen Stempeln, z. B. nur 129 und 130.
- Der Fortschritt stimmt immer. Gesammelt ist, wo man wirklich war, und die Vorschläge passen sich an das an, was schon erledigt oder anders geplant ist.

## Ausgangslage (Ist-Zustand)

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

## Niveau-Berechnung (umgesetzt am 05.10.2026, gilt für alle künftigen Touren)

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

**Bekannte Restbaustelle:** Die Saison-Tags in `tours.json` („ganzjährig – unter 600 m“, „Mai–Okt – Hochlage über 800 m“) beruhen noch auf dem höchsten Stempel, nicht auf dem höchsten Punkt des Tracks. Sie sollten ebenfalls in der App aus `maxEle` berechnet werden (mit Schritt 1 erledigen).

## Umsetzung in Schritten

Jeder Schritt ist für sich nutzbar und testbar.

### Schritt 1: Fortschritt pro Stempel und Kennzeichnung als Vorschlag

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

### Schritt 1b: Teilvorschläge für lange Touren

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
- Ergebnis der Analyse vom 05.10.2026 (km geschätzt, auf den Track-Faktor der Tour hochgerechnet):

| Tour | Teil a | Teil b | Empfehlung |
|---|---|---|---|
| A5 | 117, 118, 116, 119 Okertal (~10 km) | 91, 114 Goslar (~3–5 km) | teilen, zwei getrennte Gebiete 4 km auseinander |
| D7 | 64, 63, 62, 65 (~14 km) | 70, 68, 67, 69, 66 (~16 km) | teilen, 9 Stempel, längste Tour |
| B2 | 169, 1, 2, 3 (~15 km) | 4, 170, 122, 121 (~15 km) | optional, ~5 km Mehrweg |
| A2 | 142, 106, 107 (~12 km) | 103, 104, 102 (~14 km) | optional, ~2,5 km Mehrweg |
| D2, E3, G2 | je ~10 km | je ~10 km | optional, kaum Mehrweg |

**Nicht teilen:**
- C5 (2 Stempel) und C7 (3 Stempel mit 6 bis 7 km Abstand): in Komoot prüfen.
- B3 (Brocken): eher als Streckenwanderung mit der Brockenbahn.
- B4: Der zweite Teil hätte nur ~3 km; 18 und 156 besser als Abstecher mit dem Auto.

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

### Schritt 2: Eigene Touren

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

### Schritt 3: Vorschläge passen sich an

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

### Schritt 4: Routenabgleich anbinden

- Nach dem Abgleich erscheint „Als eigene Tour speichern“. Die erkannten Stempel „Direkt an der Route“ werden vorausgewählt, die aus „In der Nähe“ sind auswählbar.
- Aus der Modal „Erweiterte Route“ heraus gibt es „Als eigene Tour speichern“, mit dem ORS-Track.
- Die Übergabe läuft per Event `hwn:save-own-tour` ({gpx, name, stamps}), analog zu `hwn:compare-route`. Der Tourenplan öffnet dann das Formular aus Schritt 2.

### Schritt 5 (optional): Eigene Tour auf der Karte zusammenstellen

- Modus „Eigene Tour planen“: Stempel auf der Tourenkarte anklicken, die Reihenfolge per `optimizeStampOrder` oder in Klick-Reihenfolge. Danach „Auf Wanderwege legen“ (ORS) oder die Luftlinie speichern.
- Der ORS-Fehler „kein Weg innerhalb von 350 m“ wird mit dem betroffenen Stempel angezeigt.

## Offene Fragen / Entscheidungen

1. **Doppelt gezählte km bei „zurückgelegt“.** Beispiel: Erst wird „Meine Runde“ (129, 130) gelaufen, später der Rest von A1.
   - Vorschlag: „zurückgelegt“ = Summe der Tracks aller gelaufenen eigenen Touren + Track bzw. Schätzung der Vorschläge, die **als Ganzes** abgehakt wurden.
   - Ein Vorschlag, der nur durch eigene Touren und einzelne Haken vollständig wurde, zählt keine km mehr.
   - Dafür braucht es zusätzlich zu den Stempeln die Liste „als Ganzes erledigte Vorschläge“. Sie wird nur für die Statistik verwendet, nicht für den Fortschritt.
2. **Status einer eigenen Tour beim Entfernen einzelner Stempel.** Wenn man bei einer gelaufenen eigenen Tour später einen Stempel wieder entfernt:
   - Vorschlag: Die Tour bleibt „gelaufen“, es wird nur der Stempel entfernt.
3. **Speicherort eigener Touren im Projekt.** Sollen eigene Touren auch als Dateien im Repo liegen können, z. B. `src/data/own/*.gpx` mit Namen aus dem GPX?
   - Vorschlag: Zunächst nur Browser + Export, später bei Bedarf.
4. **Dateinamen beim Download.** „GPX-Track herunterladen“ speichert `HWN_<ID>.gpx`, das Projekt erwartet `<ID>.gpx`.
   - Vorschlag: Auf `<ID>.gpx` umstellen.
5. **Bekannter Verdacht im Routenabgleich, nicht geprüft.** `decodePolyline` in `map.js` dekodiert 2D, obwohl die ORS-Anfragen `elevation: true` setzen. Das ist vor Schritt 4 zu prüfen, weil die Modal „Erweiterte Route“ dort Tracks liefert.

## Nicht im Umfang

- Änderungen an `tours.json` selbst (Neuaufteilung der Vorschläge).
- Synchronisation zwischen Geräten. Das bleibt bei Export/Import.
- Build-Schritt oder npm-Abhängigkeiten. Es bleibt bei reinen ES-Modulen.
