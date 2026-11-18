#!/usr/bin/env sh
# Prints fresh production secrets. Paste them into deploy/prod.env.
# Run once. Changing ENCRYPTION_KEY later makes stored two-factor secrets unreadable.
set -eu
pg=$(openssl rand -hex 24)
echo "POSTGRES_PASSWORD=$pg"
echo "APP_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')"
echo "TRACKING_TOKEN_KEYS=k1:$(openssl rand -base64 32 | tr -d '\n')"
echo "DATABASE_URL=postgres://blissnova:$pg@postgres:5432/blissnova"
