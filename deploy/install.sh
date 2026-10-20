#!/usr/bin/env bash
# UGC Studio: install on a fresh Ubuntu/Debian VPS.
#   curl -fsSL https://raw.githubusercontent.com/weart1/UGC/<branch>/deploy/install.sh | sudo bash
# Re-running is safe: it keeps .env and data, updates the code and restarts.
set -euo pipefail

REPO="${REPO:-https://github.com/weart1/UGC.git}"
BRANCH="${BRANCH:-}"
DIR="${DIR:-/opt/ugc}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { # ask VAR "Question" [default] — reads from the terminal even when piped
  local var=$1 prompt=$2 def=${3:-} value
  if [ -n "$def" ]; then prompt="$prompt [$def]"; fi
  read -r -p "$prompt: " value </dev/tty || true
  printf -v "$var" '%s' "${value:-$def}"
}

[ "$(id -u)" = 0 ] || { echo "Запусти от root: curl ... | sudo bash"; exit 1; }

say "1/5 Пакеты"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)
systemctl enable --now docker >/dev/null 2>&1 || true

say "2/5 Код"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone ${BRANCH:+-b "$BRANCH"} "$REPO" "$DIR"
fi
cd "$DIR"

say "3/5 Настройки"
if [ ! -f .env ]; then
  ask DOMAIN "Домен панели (A-запись уже должна указывать на IP этого сервера), например ugc.example.com"
  ask RUNWARE_API_KEY "Ключ Runware (my.runware.ai → API Keys)"
  GEN_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
  ask PANEL_PASSWORD "Пароль панели" "$GEN_PASS"
  cat > .env <<ENV
DOMAIN=$DOMAIN
RUNWARE_API_KEY=$RUNWARE_API_KEY
PANEL_PASSWORD=$PANEL_PASSWORD
SESSION_SECRET=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)
JOBS=2
WHISPER_MODEL=base
ENV
  chmod 600 .env
else
  echo ".env уже есть — оставляю как есть"
fi
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
mkdir -p data

say "4/5 Файрвол"
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  echo "Открыты порты 22, 80, 443"
else
  echo "ufw не активен — проверь, что у хостера открыты порты 80 и 443"
fi

say "5/5 Сборка и запуск (первый раз 3–7 минут)"
docker compose --profile https up -d --build

for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done

say "Готово"
echo "Панель:  https://$DOMAIN"
grep -E '^PANEL_PASSWORD=' .env | sed 's/^PANEL_PASSWORD=/Пароль:  /'
echo "Данные:  $DIR/data   Настройки: $DIR/.env"
echo "Обновить: sudo bash $DIR/deploy/update.sh    Логи: cd $DIR && docker compose logs -f app"
echo "Если сайт не открывается сразу — сертификат выпускается до минуты после того, как DNS указывает на сервер."
