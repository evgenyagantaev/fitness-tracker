# Deploying the server

The API runs in Docker, bound to `127.0.0.1:8010`. Put nginx (or another reverse proxy) in front of it at `https://your.example/fitness/`. The container does not need to be public.

## 1. Copy the server to the host

```bash
rsync -av --exclude tests --exclude __pycache__ --exclude .venv \
  ./server/ user@your-host:~/fitness-tracker/
```

## 2. Token and `.env` (on the host)

```bash
cd ~/fitness-tracker
umask 077
cp .env.example .env
# put a fresh token in FITNESS_API_TOKEN, for example:
# python3 -c "import secrets; print(secrets.token_urlsafe(32))"
chmod 600 .env
```

Use that same token in the web UI and in the Android app settings.

## 3. Build and run the container

`docker compose` is optional. `./run-docker.sh` uses plain `docker build` + `docker run`:

```bash
cd ~/fitness-tracker
./run-docker.sh
curl -s http://127.0.0.1:8010/api/health        # {"ok":true,...}
docker ps --filter name=fitness-tracker
```

The compose file starts the same image, port, memory limit (256 MB) and `fitness-data` volume:

```bash
docker compose up -d --build
```

Use one of the two, not both at once.

## 4. nginx

Add the snippet in `deploy/nginx-fitness.conf` to the HTTPS `server { ... }` block of your site (`listen 443` and your `server_name`). The helper script is idempotent: it backs up the config, inserts the snippet, runs `nginx -t`, and reloads — or restores the backup if `nginx -t` fails.

```bash
sudo NGINX_CONF=/etc/nginx/sites-available/example.com \
     SERVER_NAME=example.com \
     bash deploy/install-nginx.sh
```

`reload` (not `restart`) keeps other virtual hosts and existing connections.

## 5. Check

```bash
curl -s https://example.com/fitness/api/health
curl -s -H "Authorization: Bearer <token>" https://example.com/fitness/api/stats/streaks
```

Open `https://example.com/fitness/`, enter the token, and in the Android app set the same URL and token under Settings.

## Operations

```bash
docker logs --tail 50 fitness-tracker

# SQLite backup from the volume
docker run --rm -v fitness-data:/data -v "$HOME":/backup alpine:3.20 \
  cp /data/fitness.db /backup/fitness-$(date +%F).db

# Update: rsync a new server/ tree and run ./run-docker.sh again.
# The fitness-data volume is left in place.

# Roll back nginx: restore the .bak-* copy the installer created, then
# sudo nginx -t && sudo systemctl reload nginx
```

To rotate the token, change `FITNESS_API_TOKEN` in `.env` and run `./run-docker.sh` again, then enter the new token in the app and the web UI.
