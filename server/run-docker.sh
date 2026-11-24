#!/bin/sh
# Same as docker-compose.yml, for hosts without the compose plugin.
set -e
cd "$(dirname "$0")"
[ -f .env ] || { echo "create .env first (see .env.example)"; exit 1; }
docker build -t fitness-tracker:latest .
docker rm -f fitness-tracker 2>/dev/null || true
docker run -d --name fitness-tracker --restart unless-stopped \
  --env-file .env -e FITNESS_TZ=Europe/Moscow -e FITNESS_ROOT_PATH=/fitness \
  -p 127.0.0.1:8010:8010 -v fitness-data:/data --memory 256m \
  fitness-tracker:latest
docker ps --filter name=fitness-tracker
