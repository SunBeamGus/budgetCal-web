#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

database=budget_cal
database_user=budgetcal
password_file=/etc/budget-cal/mysql-password.txt
env_file=/etc/budget-cal/budget-cal.env
token_file=/etc/budget-cal/registration-token.txt
master_key=/etc/budget-cal/master.key

if [[ ! -f "$token_file" ]]; then
  echo "Missing $token_file. Run install-server.sh first." >&2
  exit 1
fi

if [[ -f "$password_file" ]]; then
  database_password=$(cat "$password_file")
else
  database_password=$(openssl rand -hex 32)
  printf '%s\n' "$database_password" > "$password_file"
  chmod 0600 "$password_file"
fi

mysql -e "CREATE DATABASE IF NOT EXISTS \`$database\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
mysql -e "CREATE USER IF NOT EXISTS '$database_user'@'localhost' IDENTIFIED BY '$database_password'"
mysql -e "ALTER USER '$database_user'@'localhost' IDENTIFIED BY '$database_password'"
mysql -e "GRANT ALL PRIVILEGES ON \`$database\`.* TO '$database_user'@'localhost'"
mysql -e "FLUSH PRIVILEGES"

if [[ ! -f "$master_key" ]]; then
  openssl rand 32 > "$master_key"
fi
chown root:budgetcal "$master_key"
chmod 0640 "$master_key"

registration_token=$(cat "$token_file")
umask 0077
{
  printf 'STORAGE_MODE=mysql\n'
  printf 'HOST=127.0.0.1\n'
  printf 'PORT=4173\n'
  printf 'BUDGET_CAL_PUBLIC_ORIGIN=https://sunbeamgus.top\n'
  printf 'BUDGET_CAL_RP_ID=sunbeamgus.top\n'
  printf 'BUDGET_CAL_COOKIE_SECURE=true\n'
  printf 'BUDGET_CAL_ALLOWED_ORIGINS=https://sunbeamgus.top,https://www.sunbeamgus.top\n'
  printf 'BUDGET_CAL_REGISTRATION_TOKEN=%s\n' "$registration_token"
  printf 'BUDGET_CAL_DATABASE_URL=mysql://%s:%s@127.0.0.1/%s\n' \
    "$database_user" "$database_password" "$database"
  printf 'BUDGET_CAL_MASTER_KEY_FILE=%s\n' "$master_key"
} > "$env_file"
chown root:root "$env_file" "$password_file"
chmod 0600 "$env_file" "$password_file"

systemctl daemon-reload
systemctl restart budget-cal

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:4173/api/config |
    grep -q '"storage":"mysql"'; then
    echo "Budget Cal is running with MySQL storage."
    exit 0
  fi
  sleep 1
done

echo "Budget Cal did not enter MySQL mode. Inspect: journalctl -u budget-cal" >&2
exit 1
