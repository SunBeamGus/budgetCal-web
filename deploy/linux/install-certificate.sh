#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

archive=${1:-/tmp/sunbeamgus.top_nginx.zip}
nginx_config=${2:-/tmp/nginx.conf}
cert_root=/etc/budget-cal/certs

if [[ ! -f "$archive" ]]; then
  echo "Certificate archive not found: $archive" >&2
  exit 1
fi
if [[ ! -f "$nginx_config" ]]; then
  echo "Nginx configuration not found: $nginx_config" >&2
  exit 1
fi

cert_tmp=$(mktemp -d /tmp/budget-cal-cert.XXXXXX)
cleanup() {
  case "$cert_tmp" in
    /tmp/budget-cal-cert.*) rm -rf -- "$cert_tmp" ;;
  esac
}
trap cleanup EXIT

unzip -q "$archive" -d "$cert_tmp"
source_dir="$cert_tmp/sunbeamgus.top_nginx"
bundle="$source_dir/sunbeamgus.top_bundle.pem"
private_key="$source_dir/sunbeamgus.top.key"

if [[ ! -f "$bundle" || ! -f "$private_key" ]]; then
  echo "Certificate bundle or private key is missing." >&2
  exit 1
fi

openssl x509 -in "$bundle" -noout -subject -issuer -dates -ext subjectAltName
openssl x509 -in "$bundle" -noout -checkhost sunbeamgus.top
openssl x509 -in "$bundle" -noout -checkend 86400

cert_hash=$(openssl x509 -in "$bundle" -pubkey -noout |
  openssl pkey -pubin -outform der |
  openssl sha256)
key_hash=$(openssl pkey -in "$private_key" -pubout -outform der |
  openssl sha256)
if [[ "$cert_hash" != "$key_hash" ]]; then
  echo "Certificate and private key do not match." >&2
  exit 1
fi
echo "Certificate-key-match: yes"

openssl verify \
  -CAfile /etc/ssl/certs/ca-certificates.crt \
  -untrusted "$bundle" \
  "$bundle"

install -d -o root -g root -m 0755 "$cert_root"
install -o root -g root -m 0644 "$bundle" "$cert_root/sunbeamgus.top-chain.pem"
install -o root -g root -m 0600 "$private_key" "$cert_root/sunbeamgus.top-key.pem"
install -o root -g root -m 0644 "$nginx_config" /etc/nginx/sites-available/budget-cal

nginx -t
systemctl reload nginx
ss -ltnp | grep -E ':(80|443|4173) '
