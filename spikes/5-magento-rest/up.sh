#!/usr/bin/env bash
# Brings the Mage-OS sandbox up from scratch (slow: composer download + setup:install).
set -euo pipefail
cd "$(dirname "$0")"
START=$(date +%s)
DC="docker compose -p fde-spike-5"
$DC up -d --build
W="$DC exec -T -u www-data -e HOME=/tmp/wwwhome web"
$DC exec -T web bash -c 'mkdir -p /tmp/wwwhome && chown www-data:www-data /tmp/wwwhome /var/www/html'
if ! $W test -f /var/www/html/bin/magento; then
  $W composer create-project --no-interaction --repository-url=https://repo.mage-os.org/ mage-os/project-community-edition /tmp/wwwhome/proj
  $DC exec -T web bash -c 'cp -a /tmp/wwwhome/proj/. /var/www/html/ && chown -R www-data:www-data /var/www/html && rm -rf /tmp/wwwhome/proj'
fi
if ! $W test -f /var/www/html/app/etc/env.php; then
  $W php -d memory_limit=-1 bin/magento setup:install \
    --base-url=http://localhost:4380/ --db-host=db --db-name=magento --db-user=magento --db-password=spike-password \
    --admin-firstname=Spike --admin-lastname=Admin --admin-email=admin@example.com --admin-user=admin --admin-password='Admin123!spike' \
    --language=en_US --currency=USD --timezone=UTC --use-rewrites=1 \
    --search-engine=opensearch --opensearch-host=search --opensearch-port=9200 --opensearch-index-prefix=spike --opensearch-timeout=15 \
    --cleanup-database
  # no 2FA for the sandbox admin token; developer mode not needed
  $W php -d memory_limit=-1 bin/magento module:disable MageOS_PasskeyAuth Magento_TwoFactorAuth
  $W php -d memory_limit=-1 bin/magento setup:upgrade
  $W php -d memory_limit=-1 bin/magento cache:flush
fi
$DC exec -T web bash -c 'chown -R www-data:www-data /var/www/html/var /var/www/html/generated /var/www/html/pub /var/www/html/app/etc'
# async/bulk consumer (db queue, no RabbitMQ configured)
$DC exec -d -u www-data -e HOME=/tmp/wwwhome web php -d memory_limit=-1 bin/magento queue:consumers:start async.operations.all
echo "UP in $(( $(date +%s) - START )) s"
