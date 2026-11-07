ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:bookworm
FROM ${BUILD_FROM}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fluxbox \
        fonts-liberation \
        fonts-noto-color-emoji \
        novnc \
        socat \
        websockify \
        x11-utils \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN cp -r /usr/share/novnc /opt/novnc && rm -f /opt/novnc/index.html
COPY novnc-index.html /opt/novnc/index.html
COPY run.sh /run.sh
# Guard against CRLF when the folder is copied from a Windows checkout.
RUN sed -i 's/\r$//' /run.sh && chmod a+x /run.sh

CMD ["/run.sh"]
