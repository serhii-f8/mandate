#!/usr/bin/env bash
cd "$(dirname "$0")"
docker compose -p fde-spike-5 down -v
