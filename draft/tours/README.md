# Platzhalter-GPX pro Tour

Erzeugt mit `node scripts/generate-tour-drafts.js` aus `src/data/tours.json` (überschreibt alle Dateien hier).

Jede Datei enthält die Stempel der Tour als Wegpunkte (nummeriert in Tour-Reihenfolge) und eine
geschlossene Luftlinien-Runde als Track. G1 ist ein Einzelstempel und hat nur den Wegpunkt.

Verfeinern, z. B. in Komoot: Datei importieren, Route auf Wege legen, als GPX exportieren und als
`src/data/tours/<ID>.gpx` ablegen oder in der App über „GPX hinterlegen“ hochladen.
Die unveränderten Platzhalter nicht nach `src/data/tours/` kopieren, sonst zeigt die App die Luftlinie als echten Track.
