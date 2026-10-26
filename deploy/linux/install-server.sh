#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

archive=${1:-/tmp/budget-cal-deploy.tar.gz}
nginx_config=${2:-}
app_root=/opt/budget-cal
data_root=/var/lib/budget-cal
config_root=/etc/budget-cal
nginx_site=/etc/nginx/sites-available/budget-cal

if [[ ! -f "$archive" ]]; then
  echo "Deployment archive not found: $archive" >&2
  exit 1
fi

if ! id budgetcal >/dev/null 2>&1; then
  useradd \
    --system \
    --home-dir "$app_root" \
    --shell /usr/sbin/nologin \
    budgetcal
fi

if [[ -d "$app_root" ]] && [[ -n "$(find "$app_root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  mv "$app_root" "/opt/budget-cal.previous-$(date +%Y%m%d%H%M%S)"
fi

install -d -o root -g root -m 0755 "$app_root"
tar -xzf "$archive" -C "$app_root"
chown -R root:root "$app_root"
chmod -R u=rwX,go=rX "$app_root"
(cd "$app_root" && npm ci --omit=dev)
chown -R root:root "$app_root/node_modules"
chmod -R u=rwX,go=rX "$app_root/node_modules"

if [[ -z "$nginx_config" ]]; then
  nginx_config="$app_root/deploy/linux/nginx-acme.conf"
fi
if [[ ! -f "$nginx_config" ]]; then
  echo "Nginx configuration not found: $nginx_config" >&2
  exit 1
fi

install -d -o budgetcal -g budgetcal -m 0700 "$data_root"
install -d -o root -g budgetcal -m 0750 "$config_root"
install -d -o root -g root -m 0755 /var/www/budget-cal-acme

if [[ ! -f "$config_root/budget-cal.env" ]]; then
  registration_token=$(openssl rand -hex 32)
  umask 0077
  {
    printf 'STORAGE_MODE=host\n'
    printf 'HOST=127.0.0.1\n'
    printf 'PORT=4173\n'
    printf 'BUDGET_CAL_DATA_DIR=%s\n' "$data_root"
    printf 'BUDGET_CAL_PUBLIC_ORIGIN=https://sunbeamgus.top\n'
    printf 'BUDGET_CAL_RP_ID=sunbeamgus.top\n'
    printf 'BUDGET_CAL_COOKIE_SECURE=true\n'
    printf 'BUDGET_CAL_REGISTRATION_TOKEN=%s\n' "$registration_token"
  } > "$config_root/budget-cal.env"
  printf '%s\n' "$registration_token" > "$config_root/registration-token.txt"
fi
chown root:root "$config_root/budget-cal.env" "$config_root/registration-token.txt"
chmod 0600 "$config_root/budget-cal.env" "$config_root/registration-token.txt"

install \
  -o root \
  -g root \
  -m 0644 \
  "$app_root/deploy/linux/budget-cal.service" \
  /etc/systemd/system/budget-cal.service
install -o root -g root -m 0644 "$nginx_config" "$nginx_site"
ln -sfn "$nginx_site" /etc/nginx/sites-enabled/budget-cal

systemctl daemon-reload
systemctl enable budget-cal
systemctl restart budget-cal
nginx -t
systemctl enable nginx
systemctl reload nginx

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:4173/api/config >/dev/null; then
    echo "Budget Cal application is responding on 127.0.0.1:4173."
    exit 0
  fi
  sleep 1
done

echo "Budget Cal did not become ready. Inspect: journalctl -u budget-cal" >&2
exit 1
