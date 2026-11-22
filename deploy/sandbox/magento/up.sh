#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Mandate Authors
# Brings the Mage-OS sandbox up (idempotent). First run: composer download + setup:install.
# Prints "SANDBOX UP <seconds>" when the REST API answers. Development only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
START=$(date +%s)
PORT="${MANDATE_MAGENTO_PORT:-4390}"
docker network inspect mandate-sandbox >/dev/null 2>&1 || docker network create mandate-sandbox >/dev/null
DC=(docker compose -p mandate-magento-sandbox)
# Without this, BuildKit's default provenance attestation gives every build a new image ID on
# the containerd image store, so each run recreated `web` and killed the bulk consumer.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
"${DC[@]}" up -d --build
W=("${DC[@]}" exec -T -u www-data -e HOME=/tmp/wwwhome web)
"${DC[@]}" exec -T web bash -c 'mkdir -p /tmp/wwwhome && chown www-data:www-data /tmp/wwwhome /var/www/html'
if ! "${W[@]}" test -f /var/www/html/bin/magento; then
  "${W[@]}" composer create-project --no-interaction --repository-url=https://repo.mage-os.org/ \
    mage-os/project-community-edition:4.0.0 /tmp/wwwhome/proj
  "${DC[@]}" exec -T web bash -c 'cp -a /tmp/wwwhome/proj/. /var/www/html/ && chown -R www-data:www-data /var/www/html && rm -rf /tmp/wwwhome/proj'
fi
if ! "${W[@]}" test -f /var/www/html/app/etc/env.php; then
  "${W[@]}" php -d memory_limit=-1 bin/magento setup:install \
    --base-url="http://localhost:${PORT}/" --db-host=db --db-name=magento --db-user=magento --db-password=dev-only-sandbox-db \
    --admin-firstname=Sandbox --admin-lastname=Admin --admin-email=admin@example.com --admin-user=admin \
    --admin-password='dev-only-Admin1' \
    --language=en_US --currency=USD --timezone=UTC --use-rewrites=1 \
    --search-engine=opensearch --opensearch-host=search --opensearch-port=9200 --opensearch-index-prefix=sandbox \
    --opensearch-timeout=15 --cleanup-database
  # The sandbox admin token must work without 2FA; tokens live 24 hours.
  "${W[@]}" php -d memory_limit=-1 bin/magento module:disable MageOS_PasskeyAuth Magento_TwoFactorAuth
  "${W[@]}" php -d memory_limit=-1 bin/magento setup:upgrade
  "${W[@]}" php -d memory_limit=-1 bin/magento config:set oauth/access_token_lifetime/admin 24
  "${W[@]}" php -d memory_limit=-1 bin/magento cache:flush
fi
"${DC[@]}" exec -T web bash -c 'chown -R www-data:www-data /var/www/html/var /var/www/html/generated /var/www/html/pub /var/www/html/app/etc'
# The bulk consumer applies POST /async/bulk/... requests (ADR 0007, spike 5). Exactly one runs:
# re-running this script never starts a second one. A consumer started before an attribute
# schema change (the seeded `brand` attribute) has stale metadata: MANDATE_RESTART_CONSUMER=1
# restarts it.
CONSUMER_SCAN='for f in /proc/[0-9]*/cmdline; do printf "%s " "${f//[^0-9]/}"; tr "\0" " " <"$f" 2>/dev/null; echo; done | grep "[q]ueue:consumers:start async.operations.all"'
consumer_running() { "${DC[@]}" exec -T web bash -c "${CONSUMER_SCAN} >/dev/null"; }
start_consumer() {
  "${DC[@]}" exec -d -u www-data -e HOME=/tmp/wwwhome web php bin/magento queue:consumers:start async.operations.all
  for _ in $(seq 1 30); do consumer_running && return 0; sleep 1; done
  echo "CONSUMER async.operations.all did not start" >&2
  exit 1
}
if consumer_running; then
  if [[ "${MANDATE_RESTART_CONSUMER:-}" == 1 ]]; then
    "${DC[@]}" exec -T web bash -c "${CONSUMER_SCAN} | while read -r pid _; do kill \"\$pid\"; done"
    for _ in $(seq 1 30); do consumer_running || break; sleep 1; done
    if consumer_running; then echo "CONSUMER async.operations.all did not stop" >&2; exit 1; fi
    start_consumer
  fi
else
  start_consumer
fi
echo "CONSUMER async.operations.all running"
for _ in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/rest/all/V1/store/storeViews" || true)"
  if [[ "$code" == 200 || "$code" == 401 ]]; then
    echo "SANDBOX UP $(( $(date +%s) - START ))"
    exit 0
  fi
  sleep 2
done
echo "SANDBOX NOT READY (last HTTP status ${code:-none})" >&2
exit 1
