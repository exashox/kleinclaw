# Roadmap

Ziel: Sally (OpenClaw-Agent) verwaltet den Kleinanzeigen-Account. Ich schicke
eine kurze Beschreibung und Bilder, Sally recherchiert Daten und Preise und
erstellt bzw. pflegt die Anzeige.

Laufzeitumgebung: OpenClaw läuft als Add-on auf Home Assistant OS (private
Heim-IP).

## Erledigt

- **Sally Browser** (`homeassistant/sally_browser/`): HA-Add-on mit sichtbarem
  Chromium auf Xvfb, Bedienung per noVNC über die HA-Seitenleiste, CDP auf
  Port 9223 im internen Add-on-Netz. Dauerhaftes Profil, einmaliger manueller
  Login statt Login bei jedem Lauf.
- **miniclaw Connect-Modus über das interne Netz**: `--remote-debugging-host`
  akzeptiert lokale Hostnamen und private IPv4-Adressen (nur mit
  `--remote-debugging-port`). Selbst gestartete Browser bleiben auf localhost.

## Als Nächstes

1. **Sally Browser live verifizieren**: Add-on auf HA OS bauen, Ingress/noVNC
   prüfen, manuell einloggen, `kleinanzeigen_status` und `kleinanzeigen_verify`
   über den Connect-Modus laufen lassen.
2. **Preisrecherche** (`kleinanzeigen_price_research`): Aus Beschreibung und
   Bildern Suchbegriffe ableiten, über den Sally Browser vergleichbare Anzeigen
   suchen und Preisspanne, Median, Anzahl Treffer sowie typische Angaben
   (Zustand, Versand, Kategorie) zurückgeben. Ergebnis fließt in
   `kleinanzeigen_draft_ad` ein.
3. **Captcha im Connect-Modus**: Statt Abbruch den Lauf pausieren, per
   HA-Benachrichtigung auf den Sally Browser hinweisen und nach dem Lösen
   fortsetzen.

## Später

- Windows-Testlauf reparieren: 16 Tests scheitern unter Windows an
  `\`-Pfadtrennern (Redaction und Package-Checks), unabhängig vom Feature-Code.
