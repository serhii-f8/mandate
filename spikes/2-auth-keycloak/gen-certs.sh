#!/usr/bin/env bash
# Generates a throwaway CA and a TLS certificate for host.docker.internal, used only so
# that check.mjs can serve its Client ID Metadata Document over HTTPS (CIMD requires an
# https client_id URL) and Keycloak can fetch it with "Allow http scheme" left OFF.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)/.run"
mkdir -p "$dir/ca" "$dir/tls"
cd "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=fde-spike-2 throwaway CA" \
  -keyout ca/ca.key -out ca/ca.pem >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=host.docker.internal" \
  -keyout tls/server.key -out tls/server.csr >/dev/null 2>&1
printf 'subjectAltName=DNS:host.docker.internal\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > tls/ext.cnf
openssl x509 -req -in tls/server.csr -CA ca/ca.pem -CAkey ca/ca.key -CAcreateserial -days 2 \
  -extfile tls/ext.cnf -out tls/server.pem >/dev/null 2>&1
# The CA private key is not needed after signing; keep only the public CA cert for Keycloak.
rm -f ca/ca.key ca/ca.srl
chmod 644 ca/ca.pem
