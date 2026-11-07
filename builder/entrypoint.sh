#!/bin/sh
# Lancé dans le conteneur jetable (racine en lecture seule, /work en tmpfs, sans réseau).
# Entrée : archive tar des sources sur stdin.
# Sortie : archive tar sur stdout avec build.log et, si le build réussit, app.fap et appid.
set -u
cd /work || exit 1
mkdir -p src out ufbt tmp
# SDK et chaîne de compilation en lecture seule dans l'image ; ufbt écrit son état (build/) dans /work.
ln -s /opt/ufbt/current ufbt/current
ln -s /opt/ufbt/toolchain ufbt/toolchain
export UFBT_HOME=/work/ufbt TMPDIR=/work/tmp

if tar -x -C src -f - --no-same-owner --no-same-permissions >tmp/full.log 2>&1; then
  ( cd src && ufbt; echo "code de sortie : $?" ) >>tmp/full.log 2>&1 </dev/null
else
  echo "archive des sources illisible" >>tmp/full.log
fi

# Journal limité à 64 Ko : début et fin.
if [ "$(wc -c <tmp/full.log)" -gt 65536 ]; then
  { head -c 8192 tmp/full.log; printf '\n[... journal tronqué ...]\n'; tail -c 57000 tmp/full.log; } >out/build.log
else
  cp tmp/full.log out/build.log
fi

FAP=$(find src/dist -maxdepth 1 -type f -name '*.fap' 2>/dev/null | head -n1)
if [ -n "$FAP" ]; then
  cp "$FAP" out/app.fap
  basename "$FAP" .fap >out/appid
fi
tar -c -C out .
