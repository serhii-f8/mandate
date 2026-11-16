#!/usr/bin/env bash
# Brings the Mage-OS sandbox up (idempotent). First run: composer download + setup:install.
# Prints "SANDBOX UP <seconds>" when the REST API answers. Development only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
START=$(date +%s)
PORT="${AIOPS_MAGENTO_PORT:-4390}"
docker network inspect aiops-sandbox >/dev/null 2>&1 || docker network create aiops-sandbox >/dev/null
DC=(docker compose -p aiops-magento-sandbox)
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
