#!/bin/bash
# Adds the /fitness/ location to the HTTPS server block of a chosen nginx site.
# Idempotent; backs up the config; runs nginx -t; reloads on success, restores the backup on failure.
#
# Required env (no defaults — set them for your host):
#   NGINX_CONF   path to the site config, e.g. /etc/nginx/sites-available/example.com
#   SERVER_NAME  server_name to match in the listen-443 block, e.g. example.com
#
# Run:  sudo NGINX_CONF=/etc/nginx/sites-available/example.com SERVER_NAME=example.com bash ./install-nginx.sh
set -euo pipefail
CONF="${NGINX_CONF:-}"
SERVER_NAME="${SERVER_NAME:-}"
SNIPPET="$(dirname "$(readlink -f "$0")")/nginx-fitness.conf"
[ "$(id -u)" = 0 ] || { echo "Need sudo: sudo NGINX_CONF=... SERVER_NAME=... bash $0"; exit 1; }
if [ -z "$CONF" ] || [ -z "$SERVER_NAME" ]; then
  echo "Set NGINX_CONF and SERVER_NAME, for example:"
  echo "  sudo NGINX_CONF=/etc/nginx/sites-available/example.com SERVER_NAME=example.com bash $0"
  exit 1
fi
[ -f "$CONF" ] || { echo "Missing $CONF"; exit 1; }
[ -f "$SNIPPET" ] || { echo "Missing $SNIPPET"; exit 1; }

if grep -qE 'location[[:space:]]+/fitness/' "$CONF"; then
  echo "Block /fitness/ already present in $CONF — leaving it unchanged."
  nginx -t && systemctl reload nginx && echo "nginx reloaded."
  exit 0
fi

BACKUP="${CONF}.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BACKUP"
echo "Backup: $BACKUP"

set +e
python3 - "$CONF" "$SNIPPET" "$SERVER_NAME" <<'PY'
import re, sys
conf_path, snip_path, server_name = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(conf_path, encoding="utf-8").read()
snippet = open(snip_path, encoding="utf-8").read()

def blocks(s):
    """Yield (start, close) for top-level `server {` blocks, skipping comments/quotes."""
    i, n, depth, stack = 0, len(s), 0, []
    while i < n:
        c = s[i]
        if c == '#':
            j = s.find('\n', i); i = n if j < 0 else j; continue
        if c in '"\'':
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == '\\' else 1
            i = j + 1; continue
        if c == '{':
            m = re.search(r'(\w+)\s*$', s[max(0, i - 40):i])
            stack.append((m.group(1) if m else '', i, depth)); depth += 1
        elif c == '}':
            depth -= 1
            name, start, d = stack.pop()
            if name == 'server' and d == 0:
                yield start, i
        i += 1

name_re = re.compile(r'^\s*server_name\s+[^;]*\b' + re.escape(server_name) + r'\b', re.M)
cands = []
for o, c in blocks(text):
    body = text[o:c]
    if re.search(r'^\s*listen\s+[^;]*\b443\b', body, re.M) and name_re.search(body):
        cands.append((o, c))
if len(cands) != 1:
    sys.exit(f"Expected exactly one HTTPS server block for {server_name}, found: {len(cands)}. No changes made.")
o, c = cands[0]
ins = "\n    # --- fitness-tracker (added by install-nginx.sh) ---\n" + \
      "".join("    " + l + "\n" if l.strip() else "\n" for l in snippet.splitlines() if not l.startswith('#')) + \
      "    # --- /fitness-tracker ---\n"
text = text[:c] + ins + text[c:]
open(conf_path, "w", encoding="utf-8").write(text)
print("Inserted /fitness/ into the HTTPS server block.")
PY
rc=$?
set -e
if [ $rc -ne 0 ]; then cp -a "$BACKUP" "$CONF"; echo "Insert failed, config restored."; exit 1; fi

if nginx -t; then
  systemctl reload nginx
  echo "OK: nginx reloaded. Check:"
  sleep 1
  curl -s --max-time 5 "https://${SERVER_NAME}/fitness/api/health" || true; echo
else
  echo "nginx -t failed — restoring backup."
  cp -a "$BACKUP" "$CONF"
  nginx -t && echo "Previous config restored, nginx was not reloaded."
  exit 1
fi
