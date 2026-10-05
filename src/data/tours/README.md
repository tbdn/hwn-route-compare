# GPX-Tracks für den Tourenplan

Lege hier echte Tracks (z. B. Komoot-Export) als `<TOUR-ID>.gpx` ab, also `B7.gpx`, `D3.gpx` usw.
Teiltouren langer Vorschläge heißen nach ihrer ID, z. B. `A5a.gpx` und `A5b.gpx`. „GPX-Track herunterladen“
in der App speichert genau diesen Namen. Andere Dateinamen (z. B. `HWN_A5a.gpx`) lädt die App nicht; `npm test` meldet sie.
Die Tour-IDs stehen in `../tours.json`. Die App lädt die Dateien automatisch und zeigt den Track
statt der Luftlinie; km und Höhenmeter werden aus dem Track berechnet.

Ein im Browser hochgeladener Track hat Vorrang vor der Datei hier.

Ein Track kann geplant oder schon gelaufen sein. Er ändert nichts am Erledigt-Status: Als erledigt
(und in „km/Hm zurückgelegt“) zählt eine Tour nur über den Haken in der App bzw. den Fortschritt-Import.
Ein Track ohne Höhendaten (z. B. eine reine Route) liefert km aus dem Track, die Höhenmeter bleiben geschätzt.
