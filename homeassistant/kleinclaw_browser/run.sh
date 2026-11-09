#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

RESOLUTION="$(bashio::config 'resolution')"
START_URL="$(bashio::config 'start_url')"
PROFILE_DIR=/data/chromium
export DISPLAY=:99

mkdir -p "${PROFILE_DIR}"
# A container restart changes the hostname; Chromium would then treat the
# profile as locked by another machine and refuse to start.
rm -f "${PROFILE_DIR}"/Singleton{Lock,Socket,Cookie} /tmp/.X99-lock

Xvfb "${DISPLAY}" -screen 0 "${RESOLUTION}x24" -nolisten tcp &
for _ in $(seq 50); do
    xdpyinfo >/dev/null 2>&1 && break
    sleep 0.2
done

fluxbox >/dev/null 2>&1 &
# VNC and websockify stay on loopback; ingress_guard below is the only way in.
x11vnc -display "${DISPLAY}" -localhost -nopw -forever -shared -quiet -rfbport 5900 &
websockify --web /opt/novnc 127.0.0.1:6081 127.0.0.1:5900 >/dev/null 2>&1 &
# noVNC itself has no login; only HA ingress (172.30.32.2) may reach it.
python3 /ingress_guard.py 6080 6081 172.30.32.2 127.0.0.1 &
# Chromium binds CDP to loopback and accepts only IP/localhost Host headers.
# The proxy exposes it on the internal hassio network under the add-on's
# hostname (<add-on hostname>:9223), so clients need no changing IP.
# Every DevTools request must carry the token from the add-on options.
CDP_TOKEN=""
if bashio::config.has_value 'cdp_token'; then
    CDP_TOKEN="$(bashio::config 'cdp_token')"
fi
if [[ -z "${CDP_TOKEN}" ]]; then
    bashio::log.warning "Kein cdp_token gesetzt: CDP-Zugriff auf Port 9223 ist gesperrt. Token in den Optionen eintragen."
elif ! [[ "${CDP_TOKEN}" =~ ^[A-Za-z0-9_-]{16,128}$ ]]; then
    bashio::log.warning "cdp_token ungültig (16 bis 128 Zeichen aus A-Z, a-z, 0-9, - und _): CDP-Zugriff ist gesperrt."
    CDP_TOKEN=""
fi
CDP_TOKEN="${CDP_TOKEN}" python3 /cdp_proxy.py 9223 9222 &
unset CDP_TOKEN

bashio::log.info "KleinClaw Browser läuft: Oberfläche über die Seitenleiste, CDP auf Port 9223"

(
    while true; do
        chromium \
            --no-sandbox \
            --disable-dev-shm-usage \
            --no-first-run \
            --no-default-browser-check \
            --lang=de-DE \
            --start-maximized \
            --window-size="${RESOLUTION/x/,}" \
            --user-data-dir="${PROFILE_DIR}" \
            --remote-debugging-port=9222 \
            "${START_URL}" || true
        bashio::log.warning "Chromium wurde beendet, Neustart in 3 s"
        sleep 3
    done
) &

wait -n
bashio::exit.nok "Ein Hintergrunddienst des KleinClaw Browsers ist ausgefallen"
