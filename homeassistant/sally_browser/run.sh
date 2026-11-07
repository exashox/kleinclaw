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
# VNC stays on loopback; only websockify (ingress, authenticated by HA) is reachable.
x11vnc -display "${DISPLAY}" -localhost -nopw -forever -shared -quiet -rfbport 5900 &
websockify --web /opt/novnc 6080 127.0.0.1:5900 &
# Chromium binds CDP to loopback; forward it to the internal hassio network
# so miniclaw in the OpenClaw add-on can attach.
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &

bashio::log.info "Sally Browser läuft: Oberfläche über die Seitenleiste, CDP auf Port 9223"

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
bashio::exit.nok "Ein Hintergrunddienst des Sally Browsers ist ausgefallen"
