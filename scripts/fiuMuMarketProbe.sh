#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env.local" ]]; then
  LOCAL_QVERIS_API_KEY="$(sed -n 's/^QVERIS_API_KEY=//p' "$ROOT_DIR/.env.local" | head -1)"
  [[ -z "$LOCAL_QVERIS_API_KEY" ]] || QVERIS_API_KEY="$LOCAL_QVERIS_API_KEY"
fi
: "${QVERIS_API_KEY:?Set QVERIS_API_KEY or add it to .env.local.}"

BASE_URL="${QVERIS_BASE_URL:-https://qveris.ai/api/v1}"
SYMBOL="${FIU_SYMBOL:-MU.US}"
DATE="${FIU_DATE:-$(date '+%Y-%m-%d')}"
QUOTE_TOOL='fiu_mcp_server.postv1stockquote.create.v2.1790f84e'
KLINE_TOOL='fiu_mcp_server.postv1chartklinelist.create.v2.41a84fef'
QUOTE_FILE="$(mktemp)"
KLINE_FILE="$(mktemp)"

cleanup() { rm -f "$QUOTE_FILE" "$KLINE_FILE"; }
trap cleanup EXIT

execute() {
  local tool="$1" parameters="$2" output="$3"
  curl -sS --fail-with-body --max-time 90 -X POST \
    "$BASE_URL/tools/execute?tool_id=$tool" \
    -H "Authorization: Bearer $QVERIS_API_KEY" \
    -H 'Content-Type: application/json' \
    --data "{\"session_id\":\"fiu-mu-market-probe\",\"model\":\"market-data-check\",\"parameters\":$parameters,\"max_response_size\":100000}" \
    > "$output"
}

echo '========== 1. MU current quote =========='
execute "$QUOTE_TOOL" \
  "{\"fields\":[\"snapshot\"],\"symbols\":[\"$SYMBOL\"],\"timeMode\":0}" \
  "$QUOTE_FILE"

echo '========== 2. MU 1-hour candles =========='
execute "$KLINE_TOOL" \
  "{\"candleMode\":0,\"timeMode\":0,\"type\":9,\"date\":\"$DATE 23:59:59\",\"symbol\":\"$SYMBOL\",\"pageNum\":1,\"pageSize\":160}" \
  "$KLINE_FILE"

python3 - "$QUOTE_FILE" "$KLINE_FILE" <<'PY'
import json
import sys

def result(path):
    payload = json.load(open(path))
    if payload.get('success') is False or payload.get('error'):
        raise SystemExit(f"QVeris call failed: {payload}")
    value = payload.get('result', {}).get('data', payload.get('result', payload))
    if not isinstance(value, dict) or str(value.get('code', '200')) != '200':
        raise SystemExit(f"FIU call failed: {value}")
    return value

quote = result(sys.argv[1])
kline = result(sys.argv[2])
quote_row = (quote.get('body') or [None])[0]
snapshot = (quote_row or {}).get('snapshot') or {}
rows = (kline.get('body') or {}).get('list') or []
if not quote_row or snapshot.get('last') is None:
    raise SystemExit(f"FIU quote is empty: {quote}")
if not rows:
    raise SystemExit(f"FIU 1-hour candles are empty: {kline}")
latest = rows[0] if rows else {}
outliers = []
for row in rows:
    o, h, l, c = map(float, (row['open'], row['high'], row['low'], row['close']))
    if (h - l) / max(o, c, 1) > 0.15:
        outliers.append({key: row.get(key) for key in ('date', 'open', 'high', 'low', 'close')})

same_close = snapshot['last'] == latest['close']
latest_range_matches = snapshot['high'] == latest['high'] and snapshot['low'] == latest['low']
print(json.dumps({
    'symbol': (quote_row or {}).get('symbol'),
    'quote': {
        'time': snapshot.get('time'),
        'last': snapshot.get('last'),
        'open': snapshot.get('open'),
        'high': snapshot.get('high'),
        'low': snapshot.get('low'),
        'volume': snapshot.get('volume'),
        'sessionId': snapshot.get('sessionId'),
    },
    'oneHour': {
        'rows': len(rows),
        'latest': latest,
        'outlierCount': len(outliers),
        'outliers': outliers,
    },
    'quality': {
        'quoteAndLatestCandleCloseMatch': same_close,
        'quoteAndLatestCandleRangeMatch': latest_range_matches,
        'verdict': '1h high/low contains provider outliers' if outliers else 'no large outliers detected',
    },
}, ensure_ascii=False, indent=2))
PY

echo '========== Test finished =========='
