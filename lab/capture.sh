#!/usr/bin/env bash
set -euo pipefail
out="$(dirname "$0")/../src/__fixtures__"
k() { kubectl --context kind-pending-lab "$@"; }
k get nodes -o json > "$out/nodes.json"
k get pods -A -o json > "$out/pods.json"
k get pvc -A -o json > "$out/pvcs.json"
k get storageclass -o json > "$out/storageclasses.json"
k get events -n lab --field-selector reason=FailedScheduling -o json > "$out/events.json"
python3 - "$out" <<'PY'
import json, sys
out = sys.argv[1]
for name in ['nodes', 'pods', 'pvcs', 'storageclasses', 'events']:
    path = f'{out}/{name}.json'
    items = json.load(open(path))['items']
    for item in items:
        item['metadata'].pop('managedFields', None)
        item['metadata'].pop('annotations', None)
        item.get('status', {}).pop('images', None)
    json.dump({'items': items}, open(path, 'w'), indent=1)
PY
