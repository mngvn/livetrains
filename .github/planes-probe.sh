#!/usr/bin/env bash
# TEMPORARY: asks candidate aircraft feeds what a browser would get — status
# and CORS headers on GET and on a preflight. Removed before the PR.
set -u
LAT=44.95; LON=-93.2; NM=40

cors() {
  local url=$1 origin=$2
  local get pre
  get=$(curl -sS -m 20 -D - -o /tmp/b -H "Origin: $origin" -H 'Sec-Fetch-Mode: cors' "$url" 2>&1 | tr -d '\r' | grep -iE '^(HTTP|access-control-allow-origin)' | tr '\n' ' ')
  pre=$(curl -sS -m 20 -D - -o /dev/null -X OPTIONS -H "Origin: $origin" -H 'Access-Control-Request-Method: GET' "$url" 2>&1 | tr -d '\r' | grep -iE '^(HTTP|access-control-allow-origin)' | tr '\n' ' ')
  printf '%-90s %-24s GET[%s] bytes=%s  OPTIONS[%s]\n' "$url" "$origin" "$get" "$(wc -c < /tmp/b)" "$pre"
}

for origin in https://mngvn.github.io http://localhost:5173; do
  for url in \
    "https://api.adsb.lol/v2/point/$LAT/$LON/$NM" \
    "https://api.adsb.lol/v2/lat/$LAT/lon/$LON/dist/$NM" \
    "https://re-api.adsb.lol/?circle=$LAT,$LON,$NM" \
    "https://globe.adsb.lol/re-api/?circle=$LAT,$LON,$NM" \
    "https://opendata.adsb.fi/api/v2/lat/$LAT/lon/$LON/dist/$NM" \
    "https://opendata.adsb.fi/api/v3/lat/$LAT/lon/$LON/dist/$NM" \
    "https://api.adsb.one/v2/point/$LAT/$LON/$NM" \
    "https://api.adsb.one/v2/lat/$LAT/lon/$LON/dist/$NM" \
    "https://opensky-network.org/api/states/all?lamin=44.6&lomin=-93.8&lamax=45.3&lomax=-92.6" \
    "https://api.adsbdb.com/v0/callsign/DAL447" \
    "https://api.planespotters.net/pub/photos/hex/a095aa" \
    "https://hexdb.io/api/v1/aircraft/a095aa"; do
    cors "$url" "$origin"
  done
done

echo "---- samples"
curl -sS -m 20 "https://api.adsbdb.com/v0/callsign/DAL447" | head -c 1600; echo
curl -sS -m 20 "https://api.adsbdb.com/v0/callsign/EDV5350" | head -c 1600; echo
curl -sS -m 20 "https://api.adsb.one/v2/point/$LAT/$LON/$NM" | head -c 300; echo
curl -sS -m 20 "https://re-api.adsb.lol/?circle=$LAT,$LON,$NM" | head -c 300; echo
curl -sS -m 20 -H 'User-Agent: livetrains-probe' "https://api.planespotters.net/pub/photos/hex/a095aa" | head -c 600; echo
