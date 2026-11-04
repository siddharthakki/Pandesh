# Status: interne Entwürfe

Alles in diesem Ordner ist ein **interner Entwurf**. Nichts davon ist ein produktionsreifes Kundenergebnis, nichts ist veröffentlicht oder an Dritte verschickt.

| Datei | Status |
|---|---|
| `sample-site/` | Beispielseite für Gespräche (fiktive Kita „Sonnenkäfer"). Nicht ausliefern, nicht hosten. |
| `GESPRAECHSLEITFADEN.md` | Leitfaden für zwei Gespräche, die der Inhaber persönlich führt. |
| `ANTWORTEN.csv` | Notizvorlage, leer. |

## Auslieferungshindernisse (Blocker)

1. **Datenschutzerklärung unvollständig.** `sample-site/datenschutz.html` ist nur ein Platzhalter („Beispielseite erhebt keine personenbezogenen Daten …"). Eine echte Kundenseite braucht die vollständige Datenschutzerklärung der Betreiberin (selbst erstellt, z. B. mit einem Datenschutz-Generator). Solange sie fehlt oder nur Beispieltext ist, darf eine Website **nicht ausgeliefert werden**. Die Qualitätsprüfung (`qualityCheckSite` in `core/runtime/wishFulfilment.ts`) lehnt das ab und bleibt unverändert; sie wird nicht umgangen, gelockert oder mit Füllsatz bestanden.
2. Vor einem echten Auftrag fehlen weiterhin Freigaben des Inhabers: Gewerbeanmeldung/Ummeldung, Steuerstatus (§ 19 UStG ungeprüft), Vertrag.

## Nicht erlaubt bis Evidenz aus Kundengesprächen vorliegt

Keine automatische Ansprache, keine Veröffentlichung, keine Bereitstellung der Beispielseite im Netz, keine neuen Tools oder Zahlungsintegrationen.
