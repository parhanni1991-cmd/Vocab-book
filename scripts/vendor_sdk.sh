#!/usr/bin/env bash
# Anthropic TypeScript SDK를 브라우저용 ESM 한 파일(app/vendor/anthropic-sdk.js)로 묶는다.
# 사용법: scripts/vendor_sdk.sh [버전]   (기본: 0.133.0)
set -euo pipefail
VERSION="${1:-0.133.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
npm init -y >/dev/null
npm install --silent "@anthropic-ai/sdk@${VERSION}" esbuild
echo "export { default } from '@anthropic-ai/sdk';" > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=inline --outfile=out.js
{
  echo "/*! @anthropic-ai/sdk ${VERSION} | MIT License | https://github.com/anthropics/anthropic-sdk-typescript | 재생성: scripts/vendor_sdk.sh */"
  cat out.js
} > "$ROOT/app/vendor/anthropic-sdk.js"
echo "app/vendor/anthropic-sdk.js 갱신 (@anthropic-ai/sdk ${VERSION})"
