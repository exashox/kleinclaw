# KleinClaw Browser

Ein echter, sichtbarer Chromium für KleinClaw und OpenClaw-Agenten. Er läuft
auf einem virtuellen Display (Xvfb). Du siehst und bedienst ihn über die
HA-Seitenleiste (noVNC), und miniclaw sowie das Browser-Tool von OpenClaw
hängen sich per Chrome DevTools Protocol (CDP) an genau dieses Fenster.

Warum das hilft: Das Browserprofil liegt dauerhaft in `/data/chromium`. Du
meldest dich **einmal von Hand** bei Kleinanzeigen an (inklusive Captcha und
SMS-Code). Danach erkennt miniclaw die bestehende Sitzung und muss sich nicht
bei jedem Lauf neu einloggen. Wiederholte automatische Logins lösen bei
Kleinanzeigen schnell Captchas und Sperren aus.

## Installation

1. *Einstellungen → Apps → Store → ⋮ → Repositories* und die URL des
   Git-Repos eintragen, in dem dieses Add-on liegt. Für ein privates Repo mit
   Lese-Token: `https://<token>@<git-host>/<owner>/<repo>`; ein bestimmter
   Branch mit `#<branch>` am Ende. Nur ein Token mit reinem Leserecht
   verwenden: Der Supervisor schreibt die Repo-URL samt Token in sein Protokoll.
2. Im Store erscheint **KleinClaw Browser**. Installieren (der erste Build
   dauert ein paar Minuten), starten und „In Seitenleiste anzeigen“
   aktivieren.
3. Auf der Info-Seite des Add-ons steht sein **Hostname**, z.B.
   `a1b2c3d4-kleinclaw-browser`. Den brauchst du unten.
4. Unter *Konfiguration* ein **DevTools-Token** (`cdp_token`) eintragen und
   das Add-on neu starten. Ohne Token ist der CDP-Port gesperrt. Ein
   zufälliges Token erzeugst du z.B. im Terminal mit
   `openssl rand -hex 24` (16 bis 128 Zeichen aus `A-Z a-z 0-9 - _`).

Updates erscheinen wie bei jedem anderen Add-on, sobald die Version in
`config.yaml` im Repo erhöht wurde.

## Einmalig anmelden

1. In der Seitenleiste **KleinClaw Browser** öffnen.
2. Bei Kleinanzeigen einloggen und Captcha und SMS-Code selbst erledigen.
   Dabei „Angemeldet bleiben“ anhaken, falls angeboten.
3. Das Fenster offen lassen. Schließt du Chromium, startet das Add-on ihn neu.

## miniclaw verbinden

In der miniclaw-`config.yaml`, die das OpenClaw-Add-on nutzt (`configPath` in
der KleinClaw-Plugin-Konfiguration), mit dem Hostname von der Info-Seite:

```yaml
browser:
  arguments:
    - --remote-debugging-host=<hostname>
    - --remote-debugging-port=9223
    - --remote-debugging-token=<token>
```

`--remote-debugging-token` ist kein Chromium-Schalter, sondern wird nur von
miniclaw gelesen und als `?token=` mitgeschickt. KleinClaw zeigt ihn nie im
Klartext an.

Mit `--remote-debugging-port` startet miniclaw keinen eigenen Browser mehr,
sondern übernimmt den laufenden KleinClaw Browser. Am Ende schließt es nur die
Tabs, die es selbst geöffnet hat. In der Seitenleiste kannst du live zusehen.

Der Hostname bleibt gleich, auch wenn sich die IP des Add-ons nach einem
Neustart ändert. Chromium selbst akzeptiert nur IP-Adressen; ein kleiner Proxy
im Add-on (`cdp_proxy.py`) übersetzt das, sodass jeder Client den Namen
verwenden kann.

## OpenClaw-Browser-Tool verbinden

Damit der Agent auch mit dem allgemeinen Browser-Tool von OpenClaw in diesem
Browser arbeitet, im Terminal des OpenClaw-Add-ons:

```bash
openclaw config set browser.profiles.kleinclaw '{"cdpUrl":"http://<hostname>:9223?token=<token>","attachOnly":true}' --strict-json --merge
openclaw config set browser.ssrfPolicy.allowedHostnames '["<hostname>"]' --strict-json
openclaw config set browser.defaultProfile kleinclaw
openclaw browser --browser-profile kleinclaw start
openclaw browser --browser-profile kleinclaw tabs
```

Kann der Name nicht aufgelöst werden (OpenClaw-Add-on mit `host_network`), die
IP von der Info-Seite eintragen; sie kann sich nach einem Neustart ändern.

## Optionen

| Option       | Standard                                             | Bedeutung                     |
| ------------ | ---------------------------------------------------- | ----------------------------- |
| `resolution` | `1600x900`                                           | Größe des virtuellen Displays |
| `start_url`  | `https://www.kleinanzeigen.de/m-meine-anzeigen.html` | Seite beim Start              |
| `cdp_token`  | leer (CDP gesperrt)                                  | Zugangstoken für Port 9223    |

## Hinweise

- **Nicht gleichzeitig klicken.** Während der Agent arbeitet, nur zusehen.
  Eigene Klicks im selben Fenster bringen den Ablauf durcheinander.
- **Sicherheit:** Port 9223 (CDP) wird nicht auf den Host gemappt und ist nur im
  internen Add-on-Netz erreichbar. Wer CDP mit gültigem Token erreicht, kann
  den eingeloggten Browser vollständig steuern; behandle das Token wie ein
  Passwort. Abgewiesene Zugriffe stehen im Protokoll des Add-ons. Die
  noVNC-Oberfläche nimmt nur Verbindungen vom HA-Ingress an, also mit HA-Login.
- **Token ändern:** neues Token in den Optionen eintragen, Add-on neu starten,
  danach miniclaw-`config.yaml` und die OpenClaw-`cdpUrl` anpassen.
- Wenn Kleinanzeigen doch ein Captcha oder eine Gerätebestätigung zeigt,
  erledigst du sie im KleinClaw Browser. miniclaw meldet das als
  Captcha-Abbruch, danach den Lauf wiederholen.
- Automatisierte Nutzung kann gegen die Nutzungsbedingungen von Kleinanzeigen
  verstoßen und zur Sperre des Kontos führen. Login und Captchas bleiben bewusst
  beim Menschen.
