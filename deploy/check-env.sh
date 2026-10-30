#!/bin/sh
# deploy/check-env.sh — run by the config-check service before anything else
# starts. Settings that would otherwise fail minutes later, deep in a Kratos
# or Postgres log, are refused here with the reason and the fix.
fail=0
bad() { echo "deploy/.env: $1"; fail=1; }

# These three end up inside postgres:// connection URLs, where @ : / # ? % and
# friends change the meaning of the URL. (A $ is worse: Compose reads it as the
# start of a variable and silently drops what follows, so it never gets here.)
for name in POSTGRES_PASSWORD APP_DB_PASSWORD KRATOS_DB_PASSWORD; do
  eval "value=\${$name}"
  case "$value" in
    *[!A-Za-z0-9._~-]*) bad "$name may only use letters, digits and . _ ~ -  (generate one: openssl rand -hex 32)" ;;
  esac
  if [ "$DEV" != 1 ] && [ ${#value} -lt 16 ]; then bad "$name is shorter than 16 characters"; fi
done

if [ ${#KRATOS_COOKIE_SECRET} -lt 16 ]; then
  bad "KRATOS_COOKIE_SECRET must be at least 16 characters (generate one: openssl rand -hex 32)"
fi
if [ ${#KRATOS_CIPHER_SECRET} -ne 32 ]; then
  bad "KRATOS_CIPHER_SECRET must be exactly 32 characters, not ${#KRATOS_CIPHER_SECRET} (generate one: openssl rand -hex 16)"
fi
case "$APP_DOMAIN" in
  "" | *://* | */*) bad "APP_DOMAIN must be the bare host name, like money.example.com" ;;
esac
if [ $fail -eq 0 ]; then echo "deploy/.env looks right"; fi
exit $fail
