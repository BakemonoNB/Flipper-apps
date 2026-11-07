# Image « flipper-builder » : ufbt + SDK officiel 1.5.1 (API 88.2), préinstallés en lecture seule.
# Construction : docker build -t flipper-builder builder/
FROM python:3.12-slim-bookworm

ARG FW_VERSION=1.5.1
ARG API_VERSION=88.2
ARG UFBT_VERSION=0.2.6
ARG SDK_URL=https://update.flipperzero.one/builds/firmware/1.5.1/flipper-z-f7-sdk-1.5.1.zip
# Empreinte publiée dans https://update.flipperzero.one/firmware/directory.json (canal release, f7, sdk_zip).
ARG SDK_SHA256=dfde39df32ba8a9789b26afc1d702579ad8399a1c285770637cfe3287b2e2ffe

ENV UFBT_HOME=/opt/ufbt \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* \
 && pip install "ufbt==${UFBT_VERSION}"

# SDK : téléchargé, empreinte vérifiée, version d'API vérifiée (échec de la construction sinon).
RUN set -eu; \
    curl -fsSL -o /tmp/sdk.zip "$SDK_URL"; \
    echo "$SDK_SHA256  /tmp/sdk.zip" | sha256sum -c -; \
    ufbt update --local=/tmp/sdk.zip --hw-target=f7; \
    rm /tmp/sdk.zip; \
    CSV=$(find "$UFBT_HOME/current" -path '*f7*' -name api_symbols.csv | head -n1); \
    test -n "$CSV"; \
    API=$(awk -F, '$1=="Version"{print $3; exit}' "$CSV"); \
    echo "API du SDK : $API"; \
    if [ "$API" != "$API_VERSION" ]; then echo "API $API au lieu de $API_VERSION" >&2; exit 1; fi; \
    printf '{"firmware":"%s","api":"%s","ufbt":"%s"}\n' "$FW_VERSION" "$API" "$UFBT_VERSION" > /etc/flipper-sdk.json

# Construction d'essai : télécharge la chaîne de compilation et prouve que le SDK compile.
RUN set -eu; mkdir /tmp/warm && cd /tmp/warm \
 && ufbt create APPID=warmup \
 && ufbt \
 && ls -l dist/*.fap \
 && cd / && rm -rf /tmp/warm "$UFBT_HOME/build" \
 && find "$UFBT_HOME" -name '__pycache__' -prune -exec rm -rf {} + \
 && chmod -R a+rX,go-w "$UFBT_HOME"

COPY entrypoint.sh /usr/local/bin/flipper-build
RUN chmod 755 /usr/local/bin/flipper-build \
 && useradd -u 10001 -M -d /work -s /usr/sbin/nologin builder \
 && rm -rf /tmp /var/tmp && ln -s /work/tmp /tmp && ln -s /work/tmp /var/tmp
# Racine en lecture seule à l'exécution : /tmp pointe vers le tmpfs /work (SCons ne transmet pas TMPDIR à gcc).
# /etc/flipper-sdk.json (versions mesurées) est lu par le service pour /health.

LABEL org.flipper.firmware="${FW_VERSION}" org.flipper.api="${API_VERSION}"

USER 10001:10001
WORKDIR /work
ENV HOME=/work
ENTRYPOINT ["/usr/local/bin/flipper-build"]
