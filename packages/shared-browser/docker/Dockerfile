FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    x11-xserver-utils \
    chromium \
    novnc \
    websockify \
    dbus-x11 \
    fonts-liberation \
    libnss3 \
    libxss1 \
    libasound2 \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    supervisor \
    procps \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash browser && \
    mkdir -p /home/browser/.config/chromium && \
    chown -R browser:browser /home/browser

ENV DISPLAY=:99
ENV RESOLUTION=1280x720x24

RUN mkdir -p /opt/scripts

COPY run_chromium.sh /opt/scripts/run_chromium.sh
RUN chmod +x /opt/scripts/run_chromium.sh

COPY start-audio.sh /opt/scripts/start-audio.sh
RUN chmod +x /opt/scripts/start-audio.sh

COPY start-video.sh /opt/scripts/start-video.sh
RUN chmod +x /opt/scripts/start-video.sh

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 5900 6080

RUN mkdir -p /var/log/supervisor && chmod 755 /var/log/supervisor

WORKDIR /home/browser

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
