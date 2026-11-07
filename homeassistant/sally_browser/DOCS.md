# Sally Browser

Ein echter, sichtbarer Chromium für KleinClaw. Er läuft auf einem virtuellen
Display (Xvfb). Du siehst und bedienst ihn über die HA-Seitenleiste (noVNC), und
miniclaw im OpenClaw-Add-on hängt sich per Chrome DevTools Protocol (CDP) an
genau dieses Fenster.

Warum das hilft: Das Browserprofil liegt dauerhaft in `/data/chromium`. Du
meldest dich **einmal von Hand** bei Kleinanzeigen an (inklusive Captcha und
SMS-Code). Danach erkennt miniclaw die bestehende Sitzung und muss sich nicht
bei jedem Lauf neu einloggen. Genau diese wiederholten Logins haben bisher
Captchas und die IP-Sperre ausgelöst.

## Installation (lokales Add-on)

1. Den Ordner `sally_browser` nach `/addons/sally_browser` auf deinem HA OS
   kopieren, z.B. mit dem Samba- oder dem SSH-Add-on.
2. *Einstellungen → Add-ons → Add-on-Store → ⋮ → Nach Updates suchen*.
   Unter „Lokale Add-ons“ erscheint **Sally Browser**.
3. Installieren (der erste Build dauert ein paar Minuten), starten und
   „In Seitenleiste anzeigen“ aktivieren.

## Einmalig anmelden

1. In der Seitenleiste **Sally Browser** öffnen.
2. Bei Kleinanzeigen einloggen und Captcha und SMS-Code selbst erledigen.
   Dabei „Angemeldet bleiben“ anhaken, falls angeboten.
3. Das Fenster offen lassen. Schließt du Chromium, startet das Add-on ihn neu.

## miniclaw verbinden

In der miniclaw-`config.yaml`, die das OpenClaw-Add-on nutzt (`configPath` in
der KleinClaw-Plugin-Konfiguration):

```yaml
browser:
  arguments:
    - --remote-debugging-host=local-sally-browser
    - --remote-debugging-port=9223
```

Mit `--remote-debugging-port` startet miniclaw keinen eigenen Browser mehr,
sondern übernimmt den laufenden Sally Browser. Am Ende schließt es nur die Tabs,
die es selbst geöffnet hat. In der Seitenleiste kannst du live zusehen, was
Sally tut.

`local-sally-browser` ist der interne Hostname des Add-ons. miniclaw löst ihn zu
einer IP auf und akzeptiert nur private Adressen. Läuft das OpenClaw-Add-on mit
`host_network` und kann den Namen nicht auflösen, trage stattdessen die IP aus
`ha addons info local_sally_browser` (Feld `ip_address`) ein. Die
IP kann sich nach einem Neustart ändern.

## Optionen

| Option       | Standard                                             | Bedeutung                     |
| ------------ | ---------------------------------------------------- | ----------------------------- |
| `resolution` | `1600x900`                                           | Größe des virtuellen Displays |
| `start_url`  | `https://www.kleinanzeigen.de/m-meine-anzeigen.html` | Seite beim Start              |

## Hinweise

- **Nicht gleichzeitig klicken.** Während Sally arbeitet, nur zusehen. Eigene
  Klicks im selben Fenster bringen den Ablauf durcheinander.
- **Sicherheit:** Port 9223 (CDP) wird nicht auf den Host gemappt und ist nur im
  internen Add-on-Netz erreichbar. Wer CDP erreicht, kann den eingeloggten
  Browser vollständig steuern. Installiere daher nur Add-ons, denen du vertraust.
  Die noVNC-Oberfläche ist nur über HA-Ingress erreichbar, also mit HA-Login.
- Wenn Kleinanzeigen doch wieder ein Captcha oder eine Gerätebestätigung zeigt,
  erledigst du sie einfach im Sally Browser. miniclaw meldet das als
  Captcha-Abbruch, danach den Lauf wiederholen.
