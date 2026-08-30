#!/usr/bin/env bash
set -euo pipefail

cd /opt/dna

git fetch origin main
git reset --hard origin/main

sudo systemctl restart dna.service

sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload dna-caddy