FROM node:22-bookworm-slim

# ffmpeg: assembly; yt-dlp: examples by link; faster-whisper: transcript of the example.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core python3 python3-pip ca-certificates \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp faster-whisper \
  && rm -rf /var/lib/apt/lists/* /root/.cache

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .

ENV DATA_DIR=/data \
    PORT=3000 \
    HF_HOME=/data/.models
VOLUME /data
EXPOSE 3000
CMD ["pnpm", "ugc", "serve"]
