# Spike 5 - Magento 2 REST (Mage-OS sandbox)

Throwaway code. De-risks CONN-2, OPS-6, EXE-4, CS-7.

## Prerequisites

Docker with Compose v2, Node 22, npm, about 3 GB RAM free, internet (composer from `repo.mage-os.org`, no keys).

## Run

```sh
./up.sh     # from scratch: builds php:8.3-apache image, MariaDB 11.4, OpenSearch 3.0.0, composer create-project
            # mage-os/project-community-edition, setup:install, starts the async consumer. About 7 min.
./run.sh    # assertions, about 3 min; assumes the sandbox is up; resets its own SPK-* products, restarts the consumer
./down.sh   # docker compose -p fde-spike-5 down -v  (removes containers, network, volumes)
```

- Compose project `fde-spike-5`; only published port is `127.0.0.1:4380` (web). Admin: `admin` / `Admin123!spike`
  (REST token via `POST /rest/V1/integration/admin/token`; 2FA modules are disabled in the sandbox).
- Magento source lives in the named volume `fde-spike-5_magento-src`, not in this directory.
- `run.sh` writes `out/` (schema dumps, `observations.json`, `run.log`); `out/` and `node_modules/` are git-ignored.
- The async queue is the default MySQL (db) queue; no RabbitMQ and no cron are needed. The consumer is started by
  `up.sh` and restarted by `run.sh` (`bin/magento queue:consumers:start async.operations.all`, runs in the web container).
- Files: `check.mjs` (assertions), `lib.mjs` (client), `parse-schema.mjs` (parser timing/memory, run as child process).
