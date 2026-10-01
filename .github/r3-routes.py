# TEMPORARY: what Metro Transit's routes look like, to tune how lines are tiered.
import csv, io, sys, zipfile, collections

z = zipfile.ZipFile(sys.argv[1])
def rows(name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))

routes = {r['route_id']: r for r in rows('routes.txt')}
trip_route = {t['trip_id']: t['route_id'] for t in rows('trips.txt')}
stops_by_route = collections.defaultdict(set)
for st in rows('stop_times.txt'):
    r = trip_route.get(st['trip_id'])
    if r: stops_by_route[r].add(st['stop_id'])

print('ROUTES', len(routes))
hist = collections.Counter((r.get('route_type'), (r.get('route_color') or '').upper()) for r in routes.values())
for (t, c), n in hist.most_common():
    stops = set()
    for r in routes.values():
        if r.get('route_type') == t and (r.get('route_color') or '').upper() == c:
            stops |= stops_by_route[r['route_id']]
    print(f'COLOR type={t} color={c or "-"} routes={n} stops={len(stops)}')
for r in sorted(routes.values(), key=lambda r: (r.get('route_type'), r.get('route_sort_order') or '', r['route_id'])):
    print('R', r.get('route_type'), (r.get('route_color') or '-').upper(), r.get('agency_id', ''), repr(r.get('route_short_name')), repr((r.get('route_long_name') or '')[:40]), r.get('route_desc', '')[:30], len(stops_by_route[r['route_id']]))
