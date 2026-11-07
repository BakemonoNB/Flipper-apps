#!/bin/sh
# Déploie origin/main dans le clone root /opt/flipper-builder si builder/ a changé :
# reconstruit l'image si Dockerfile ou entrypoint.sh ont changé, puis redémarre flipper-builder.
# Installé dans /usr/local/bin (root), lancé par flipper-builder-deploy.timer.
set -eu
cd /opt/flipper-builder
git fetch -q origin main
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" -- builder/)
# Image reconstruite avant le reset : si la construction échoue, on réessaie au prochain passage.
if echo "$CHANGED" | grep -qE '^builder/(Dockerfile|entrypoint\.sh)$'; then
  git archive "$REMOTE:builder" | docker build -q -t flipper-builder - >/dev/null
fi
git reset -q --hard origin/main
chmod -R go-w /opt/flipper-builder
[ -z "$CHANGED" ] && exit 0
systemctl restart flipper-builder
echo "builder déployé ${LOCAL%"${LOCAL#???????}"} -> ${REMOTE%"${REMOTE#???????}"}"
