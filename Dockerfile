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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/cli.ts", "serve"]
