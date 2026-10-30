#!/bin/sh
# Runs once, when the data directory is empty (docker-entrypoint-initdb.d).
# Two databases, two login roles. `app` is the api's runtime role: it owns
# nothing, so row-level security applies to every query it makes. The app
# tables are created by migrations running as the superuser.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$APP_DB_PASSWORD" -v kratos_password="$KRATOS_DB_PASSWORD" <<'SQL'
CREATE ROLE app LOGIN PASSWORD :'app_password';
CREATE DATABASE app;
REVOKE ALL ON DATABASE app FROM PUBLIC;
GRANT CONNECT ON DATABASE app TO app;
CREATE ROLE kratos LOGIN PASSWORD :'kratos_password';
CREATE DATABASE kratos OWNER kratos;
SQL
