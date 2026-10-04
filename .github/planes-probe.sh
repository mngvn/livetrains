#!/usr/bin/env bash
# TEMPORARY: can a static page reach the aircraft feed through a public CORS
# proxy, and does the data come through fresh? Removed before the PR.
set -u
ORIGIN=https://mngvn.github.io
UP='https://api.adsb.lol/v2/point/44.95/-93.2/40'
UP2='https://opendata.adsb.fi/api/v2/lat/44.95/lon/-93.2/dist/40'
enc() { jq -rn --arg u "$1" '$u|@uri'; }

try() {
  local name=$1 url=$2
  for i in 1 2 3; do
    local out
    out=$(curl -sS -m 25 -D /tmp/h -o /tmp/b -w '%{http_code} %{time_total}s' -H "Origin: $ORIGIN" "$url" 2>&1)
    local acao now count
    acao=$(tr -d '\r' < /tmp/h | grep -i '^access-control-allow-origin' | head -1)
    now=$(jq -r '(.now // (.contents | fromjson? | .now)) // "?"' /tmp/b 2>/dev/null || echo '?')
    count=$(jq -r '((.ac // .aircraft) // (.contents | fromjson? | (.ac // .aircraft))) | length' /tmp/b 2>/dev/null || echo '?')
    printf '%-14s %s  %s  now=%s aircraft=%s  %s\n' "$name" "$out" "${acao:-no-acao}" "$now" "$count" "$(head -c 80 /tmp/b | tr '\n' ' ')"
    sleep 6
  done
}

try allorigins-raw "https://api.allorigins.win/raw?url=$(enc "$UP")"
try allorigins-get "https://api.allorigins.win/get?url=$(enc "$UP")"
try codetabs       "https://api.codetabs.com/v1/proxy/?quest=$UP"
try corsproxy.io   "https://corsproxy.io/?url=$(enc "$UP")"
try cors.lol       "https://api.cors.lol/?url=$(enc "$UP")"
try everyorigin    "https://everyorigin.jwvbremen.nl/api/get?url=$(enc "$UP")"
try cf-test        "https://test.cors.workers.dev/?$UP"
try thingproxy     "https://thingproxy.freeboard.io/fetch/$UP"
try allorigins-fi  "https://api.allorigins.win/raw?url=$(enc "$UP2")"
try codetabs-fi    "https://api.codetabs.com/v1/proxy/?quest=$UP2"
