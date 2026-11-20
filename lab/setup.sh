#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
kind create cluster --config kind.yaml
kubectl --context kind-pending-lab wait --for=condition=Ready nodes --all --timeout=180s
kubectl --context kind-pending-lab taint nodes pending-lab-worker2 dedicated=gpu:NoSchedule --overwrite
kubectl --context kind-pending-lab create namespace lab
kubectl --context kind-pending-lab apply -n lab -f pods.yaml
