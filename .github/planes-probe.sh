#!/usr/bin/env bash
# TEMPORARY: asks each candidate aircraft feed what a browser would get —
# status, CORS headers, and the shape of the data. Removed before the PR.
set -u
ORIGIN='https://mngvn.github.io'
LAT=44.95; LON=-93.2; NM=40

probe() {
  local name=$1 url=$2
  echo "================ $name"
  echo "GET $url"
  curl -sS -m 30 -D /tmp/h.txt -o /tmp/b.json -H "Origin: $ORIGIN" -H 'Accept: application/json' "$url" || echo "curl failed"
  grep -iE '^(HTTP|access-control|content-type|cache-control|x-rate|ratelimit|retry-after|vary)' /tmp/h.txt
  echo "bytes: $(wc -c < /tmp/b.json)"
  if jq -e . /tmp/b.json >/dev/null 2>&1; then
    echo "top-level keys: $(jq -c 'keys' /tmp/b.json)"
    jq -c 'del(.ac, .aircraft, .states)' /tmp/b.json | head -c 400; echo
    local list='(.ac // .aircraft // [])'
    echo "aircraft: $(jq "$list | length" /tmp/b.json)"
    echo "with position: $(jq "[$list[] | select(.lat != null)] | length" /tmp/b.json)"
    echo "on ground: $(jq "[$list[] | select(.alt_baro == \"ground\")] | length" /tmp/b.json)"
    echo "field counts:"; jq -c "[$list[] | keys[]] | group_by(.) | map({(.[0]): length}) | add" /tmp/b.json
    echo "categories: $(jq -c "[$list[] | .category // \"none\"] | group_by(.) | map({(.[0]): length}) | add" /tmp/b.json)"
    echo "types: $(jq -c "[$list[] | .type // \"none\"] | group_by(.) | map({(.[0]): length}) | add" /tmp/b.json)"
    echo "callsigns: $(jq -c "[$list[] | .flight // empty] | .[:40]" /tmp/b.json)"
    echo "samples:"; jq -c "[$list[] | select(.lat != null)] | sort_by(.alt_baro | tostring) | .[0,5,10,20]" /tmp/b.json
    jq -c '.states | length?, .[0:3]?' /tmp/b.json 2>/dev/null | head -c 800; echo
  else
    head -c 400 /tmp/b.json; echo
  fi
}

probe adsb.lol        "https://api.adsb.lol/v2/point/$LAT/$LON/$NM"
probe airplanes.live  "https://api.airplanes.live/v2/point/$LAT/$LON/$NM"
probe adsb.fi         "https://opendata.adsb.fi/api/v2/lat/$LAT/lon/$LON/dist/$NM"
probe opensky         "https://opensky-network.org/api/states/all?lamin=44.6&lomin=-93.8&lamax=45.3&lomax=-92.6"

echo "================ rate: three quick GETs to each"
for url in "https://api.adsb.lol/v2/point/$LAT/$LON/$NM" "https://api.airplanes.live/v2/point/$LAT/$LON/$NM" "https://opendata.adsb.fi/api/v2/lat/$LAT/lon/$LON/dist/$NM"; do
  for i in 1 2 3; do curl -sS -m 20 -o /dev/null -w "$url %{http_code} %{time_total}s\n" -H "Origin: $ORIGIN" "$url"; sleep 1; done
done

# Route and aircraft lookups for whatever is overhead right now.
curl -sS -m 30 -o /tmp/b.json "https://api.adsb.lol/v2/point/$LAT/$LON/$NM"
CALLS=$(jq -r '[.ac[] | .flight // empty | gsub(" ";"") | select(length>0)] | .[:4] | .[]' /tmp/b.json)
HEXES=$(jq -r '[.ac[] | .hex] | .[:2] | .[]' /tmp/b.json)
echo "callsigns to look up: $CALLS"
for c in $CALLS; do
  probe "adsbdb callsign $c" "https://api.adsbdb.com/v0/callsign/$c"; cat /tmp/b.json | head -c 1500; echo
done
for h in $HEXES; do
  probe "adsbdb aircraft $h" "https://api.adsbdb.com/v0/aircraft/$h"; cat /tmp/b.json | head -c 1500; echo
done
FIRST=$(echo "$CALLS" | head -1)
probe "hexdb route $FIRST" "https://hexdb.io/callsign-route?callsign=$FIRST"; cat /tmp/b.json | head -c 300; echo

echo "================ adsb.lol routeset preflight"
curl -sS -m 20 -D - -o /dev/null -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' https://api.adsb.lol/api/0/routeset | grep -iE '^(HTTP|access-control)'
BODY=$(jq -c '{planes: [.ac[] | select(.flight != null and .lat != null) | {callsign: (.flight | gsub(" ";"")), lat: .lat, lng: .lon}] | .[:4]}' /tmp/b.json)
echo "POST $BODY"
curl -sS -m 30 -D /tmp/h.txt -o /tmp/r.json -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$BODY" https://api.adsb.lol/api/0/routeset
grep -iE '^(HTTP|access-control|content-type)' /tmp/h.txt; head -c 2500 /tmp/r.json; echo
