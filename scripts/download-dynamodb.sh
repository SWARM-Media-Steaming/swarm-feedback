#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.dynamodb"
if [ -f "$DEST/DynamoDBLocal.jar" ]; then
  exit 0
fi
mkdir -p "$DEST"
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/dynamodb_local_latest.zip" "https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.zip"
unzip -q -o "$TMP/dynamodb_local_latest.zip" -d "$DEST"
rm -rf "$TMP"
