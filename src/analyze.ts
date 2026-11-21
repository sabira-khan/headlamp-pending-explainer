import type {
  ClusterState,
  KubeEvent,
  LabelSelector,
  LabelSelectorRequirement,
  Node,
  NodeSelectorTerm,
  Pod,
  PodAffinityTerm,
  Taint,
  Toleration,
} from './kube';
import { parseSchedulerMessage, type ReasonKind, type SchedulerMessage } from './parse';
import { formatResource, parseQuantity } from './quantity';

export interface Blocker {
  kind: ReasonKind;
  summary: string;
  resource?: string;
  requested?: number;
  free?: number;
  capacity?: number;
  taint?: Taint;
  pod?: string;
}

export interface NodeVerdict {
  node: string;
  fits: boolean;
  blockers: Blocker[];
}

export interface Fix {
  title: string;
  detail: string;
  snippet?: string;
}

export interface Explanation {
  scheduled: boolean;
  podLevel: Blocker[];
  nodes: NodeVerdict[];
  fixes: Fix[];
  scheduler: SchedulerMessage | null;
  agreement: { checked: boolean; matches: boolean; differences: string[] };
  gates: string[];
}

const ORDER: ReasonKind[] = [
  'unschedulable',
  'taint',
  'nodeAffinity',
  'ports',
  'resources',
  'volumeBinding',
  'topologySpread',
  'podAffinity',
  'podAntiAffinity',
];
const CONTROL_PLANE_TAINTS = [
  'node-role.kubernetes.io/control-plane',
  'node-role.kubernetes.io/master',
];

export function taintText(taint: Taint): string {
  return `${taint.key}${taint.value ? `=${taint.value}` : ''}:${taint.effect}`;
}

export function tolerates(tolerations: Toleration[] = [], taint: Taint): boolean {
  return tolerations.some(t => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (t.operator === 'Exists') return !t.key || t.key === taint.key;
    return t.key === taint.key && (t.value ?? '') === (taint.value ?? '');
  });
}

function requirementMatches(
  labels: Record<string, string>,
  req: LabelSelectorRequirement
): boolean {
  const has = Object.prototype.hasOwnProperty.call(labels, req.key);
  const value = labels[req.key];
  const values = req.values ?? [];
  switch (req.operator) {
    case 'In':
      return has && values.includes(value);
    case 'NotIn':
      return !has || !values.includes(value);
    case 'Exists':
      return has;
    case 'DoesNotExist':
      return !has;
    case 'Gt':
      return has && Number(value) > Number(values[0]);
    case 'Lt':
      return has && Number(value) < Number(values[0]);
    default:
      return false;
  }
}

export function selectorMatches(
  selector: LabelSelector | undefined,
  labels: Record<string, string> = {}
): boolean {
  if (!selector) return false;
  const exact = Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels[k] === v);
  return exact && (selector.matchExpressions ?? []).every(req => requirementMatches(labels, req));
}

function termMatches(term: NodeSelectorTerm, node: Node): boolean {
  const labels = node.metadata.labels ?? {};
  const fields = { 'metadata.name': node.metadata.name };
  const expressions = term.matchExpressions ?? [];
  const matchFields = term.matchFields ?? [];
  if (!expressions.length && !matchFields.length) return false;
  return (
    expressions.every(req => requirementMatches(labels, req)) &&
    matchFields.every(req => requirementMatches(fields, req))
  );
}

function active(pod: Pod) {
  return pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed';
}

export function podRequests(pod: Pod): Record<string, number> {
  const total: Record<string, number> = {};
  for (const c of pod.spec.containers ?? []) {
    for (const [name, value] of Object.entries(c.resources?.requests ?? {}))
      total[name] = (total[name] ?? 0) + parseQuantity(value);
  }
  for (const c of pod.spec.initContainers ?? []) {
    for (const [name, value] of Object.entries(c.resources?.requests ?? {}))
      total[name] = Math.max(total[name] ?? 0, parseQuantity(value));
  }
  for (const [name, value] of Object.entries(pod.spec.overhead ?? {}))
    total[name] = (total[name] ?? 0) + parseQuantity(value);
  return total;
}

function hostPorts(pod: Pod) {
  return [...(pod.spec.initContainers ?? []), ...pod.spec.containers]
    .flatMap(c => c.ports ?? [])
    .filter(p => p.hostPort)
    .map(p => ({
      port: p.hostPort as number,
      protocol: p.protocol ?? 'TCP',
      ip: p.hostIP || '0.0.0.0',
    }));
}

function podName(pod: Pod) {
  return pod.metadata.namespace
    ? `${pod.metadata.namespace}/${pod.metadata.name}`
    : pod.metadata.name;
}

function sameDomain(a: Node, b: Node, key: string) {
  const va = a.metadata.labels?.[key];
  return va !== undefined && va === b.metadata.labels?.[key];
}

function termApplies(term: PodAffinityTerm, owner: Pod, other: Pod) {
  const namespaces = term.namespaces?.length ? term.namespaces : [owner.metadata.namespace];
  return (
    namespaces.includes(other.metadata.namespace) &&
    selectorMatches(term.labelSelector, other.metadata.labels)
  );
}

function checkNode(
  pod: Pod,
  node: Node,
  state: ClusterState,
  requests: Record<string, number>
): Blocker[] {
  const blockers: Blocker[] = [];
  const tolerations = pod.spec.tolerations ?? [];
  const nodesByName = new Map(state.nodes.map(n => [n.metadata.name, n]));
  const placed = state.pods.filter(
    p => p.spec.nodeName && active(p) && p.metadata.uid !== pod.metadata.uid
  );
  const onNode = placed.filter(p => p.spec.nodeName === node.metadata.name);

  if (
    node.spec?.unschedulable &&
    !tolerates(tolerations, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })
  ) {
    blockers.push({ kind: 'unschedulable', summary: 'Node is cordoned (unschedulable)' });
  }

  for (const taint of node.spec?.taints ?? []) {
    if (taint.effect === 'PreferNoSchedule' || tolerates(tolerations, taint)) continue;
    if (taint.key === 'node.kubernetes.io/unschedulable' && node.spec?.unschedulable) continue;
    const notReady = /^node\.kubernetes\.io\/(not-ready|unreachable)$/.test(taint.key);
    blockers.push({
      kind: notReady ? 'notReady' : 'taint',
      summary: `Taint ${taintText(taint)} is not tolerated`,
      taint,
    });
  }

  const labels = node.metadata.labels ?? {};
  const selector = pod.spec.nodeSelector ?? {};
  const wrong = Object.entries(selector).filter(([k, v]) => labels[k] !== v);
  if (wrong.length) {
    const has = wrong.map(
      ([k, v]) =>
        `${k}=${v} (node has ${labels[k] === undefined ? 'no such label' : `${k}=${labels[k]}`})`
    );
    blockers.push({
      kind: 'nodeAffinity',
      summary: `Node selector does not match: ${has.join(', ')}`,
    });
  }
  const terms =
    pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution
      ?.nodeSelectorTerms;
  if (terms?.length && !terms.some(term => termMatches(term, node))) {
    blockers.push({
      kind: 'nodeAffinity',
      summary: 'Required node affinity does not match this node',
    });
  }

  const usedPorts = onNode.flatMap(p => hostPorts(p).map(port => ({ ...port, pod: podName(p) })));
  for (const want of hostPorts(pod)) {
    const clash = usedPorts.find(
      u =>
        u.port === want.port &&
        u.protocol === want.protocol &&
        (u.ip === '0.0.0.0' || want.ip === '0.0.0.0' || u.ip === want.ip)
    );
    if (clash)
      blockers.push({
        kind: 'ports',
        summary: `Host port ${want.port}/${want.protocol} is already used by ${clash.pod}`,
        pod: clash.pod,
      });
  }

  const allocatable = node.status?.allocatable ?? {};
  const used: Record<string, number> = {};
  for (const p of onNode)
    for (const [name, value] of Object.entries(podRequests(p)))
      used[name] = (used[name] ?? 0) + value;
  const maxPods = parseQuantity(allocatable.pods);
  if (maxPods && onNode.length + 1 > maxPods)
    blockers.push({
      kind: 'resources',
      resource: 'pods',
      requested: 1,
      free: Math.max(0, maxPods - onNode.length),
      summary: `Node already runs its maximum of ${maxPods} pods`,
    });
  for (const [resource, requested] of Object.entries(requests)) {
    if (!requested) continue;
    const capacity = parseQuantity(allocatable[resource] ?? '0');
    const free = capacity - (used[resource] ?? 0);
    if (requested > free) {
      blockers.push({
        kind: 'resources',
        resource,
        requested,
        free,
        capacity,
        summary: `Insufficient ${resource}: pod requests ${formatResource(
          resource,
          requested
        )}, node has ${formatResource(resource, Math.max(0, free))} free`,
      });
    }
  }

  for (const term of pod.spec.affinity?.podAffinity
    ?.requiredDuringSchedulingIgnoredDuringExecution ?? []) {
    const matching = placed.filter(p => termApplies(term, pod, p));
    const selfMatch = termApplies(term, pod, pod);
    const ok =
      matching.some(p =>
        sameDomain(node, nodesByName.get(p.spec.nodeName!) ?? node, term.topologyKey)
      ) ||
      (!matching.length && selfMatch);
    if (!ok)
      blockers.push({
        kind: 'podAffinity',
        summary: `No pod matching the affinity rule runs in this node's ${term.topologyKey} domain`,
      });
  }

  for (const term of pod.spec.affinity?.podAntiAffinity
    ?.requiredDuringSchedulingIgnoredDuringExecution ?? []) {
    const clash = placed.find(
      p =>
        termApplies(term, pod, p) &&
        sameDomain(
          node,
          nodesByName.get(p.spec.nodeName!) ?? { metadata: { name: '' } },
          term.topologyKey
        )
    );
    if (clash)
      blockers.push({
        kind: 'podAntiAffinity',
        summary: `Anti-affinity rule: ${podName(clash)} already runs in the same ${
          term.topologyKey
        } domain`,
        pod: podName(clash),
      });
  }
  for (const other of placed) {
    for (const term of other.spec.affinity?.podAntiAffinity
      ?.requiredDuringSchedulingIgnoredDuringExecution ?? []) {
      const host = nodesByName.get(other.spec.nodeName!);
      const already = blockers.some(b => b.kind === 'podAntiAffinity' && b.pod === podName(other));
      if (
        !already &&
        host &&
        termApplies(term, other, pod) &&
        sameDomain(node, host, term.topologyKey)
      ) {
        blockers.push({
          kind: 'podAntiAffinity',
          summary: `${podName(other)} has an anti-affinity rule that keeps this pod out of its ${
            term.topologyKey
          } domain`,
          pod: podName(other),
        });
      }
    }
  }

  return blockers;
}

function volumeBlockers(pod: Pod, state: ClusterState): Blocker[] {
  if (!state.pvcs) return [];
  const blockers: Blocker[] = [];
  const classes = state.storageClasses ?? [];
  for (const volume of pod.spec.volumes ?? []) {
    const claimName = volume.persistentVolumeClaim?.claimName;
    if (!claimName) continue;
    const pvc = state.pvcs.find(
      c => c.metadata.name === claimName && c.metadata.namespace === pod.metadata.namespace
    );
    if (!pvc) {
      blockers.push({
        kind: 'volumeBinding',
        summary: `PersistentVolumeClaim ${claimName} does not exist`,
      });
      continue;
    }
    if (pvc.status?.phase === 'Bound') continue;
    const className = pvc.spec?.storageClassName;
    const storageClass = className ? classes.find(c => c.metadata.name === className) : undefined;
    if (className && state.storageClasses && !storageClass) {
      blockers.push({
        kind: 'volumeBinding',
        summary: `PersistentVolumeClaim ${claimName} uses StorageClass ${className}, which does not exist`,
      });
    } else if (storageClass?.volumeBindingMode === 'WaitForFirstConsumer') {
      continue;
    } else {
      blockers.push({
        kind: 'volumeBinding',
        summary: `PersistentVolumeClaim ${claimName} is ${
          pvc.status?.phase ?? 'not bound'
        } and has no volume yet`,
      });
    }
  }
  return blockers;
}

function first(blockers: Blocker[]): Blocker | undefined {
  const rank = (k: ReasonKind) =>
    k === 'notReady'
      ? ORDER.indexOf('taint')
      : ORDER.indexOf(k) === -1
      ? ORDER.length
      : ORDER.indexOf(k);
  return [...blockers].sort((a, b) => rank(a.kind) - rank(b.kind))[0];
}

export function latestSchedulingMessage(pod: Pod, events: KubeEvent[] = []): string | null {
  const condition = pod.status?.conditions?.find(
    c => c.type === 'PodScheduled' && c.status === 'False' && c.message
  );
  const time = (e: KubeEvent) =>
    e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? '';
  const event = events
    .filter(
      e =>
        e.reason === 'FailedScheduling' &&
        e.involvedObject?.name === pod.metadata.name &&
        e.involvedObject?.namespace === pod.metadata.namespace
    )
    .sort((a, b) => time(b).localeCompare(time(a)))[0];
  return condition?.message ?? event?.message ?? null;
}

function compare(
  scheduler: SchedulerMessage,
  nodes: NodeVerdict[],
  podLevel: Blocker[]
): Explanation['agreement'] {
  if (
    scheduler.total === null ||
    (scheduler.reasons.length && scheduler.reasons.every(r => r.count === null))
  ) {
    const kinds = new Set(podLevel.map(b => b.kind));
    const differences = scheduler.reasons
      .filter(r => !kinds.has(r.kind))
      .map(r => `Scheduler reported "${r.text}"`);
    return { checked: true, matches: differences.length === 0, differences };
  }
  if (podLevel.length) return { checked: false, matches: false, differences: [] };
  const counts = new Map<string, number>();
  for (const verdict of nodes) {
    const lead = first(verdict.blockers);
    if (!lead) continue;
    if (lead.kind === 'resources') {
      for (const b of verdict.blockers.filter(x => x.kind === 'resources'))
        counts.set(`resources:${b.resource}`, (counts.get(`resources:${b.resource}`) ?? 0) + 1);
    } else {
      const key = lead.kind === 'notReady' ? 'taint' : lead.kind;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const expected = new Map<string, number>();
  for (const r of scheduler.reasons) {
    const key =
      r.kind === 'resources' ? `resources:${r.resource}` : r.kind === 'notReady' ? 'taint' : r.kind;
    expected.set(key, (expected.get(key) ?? 0) + (r.count ?? 0));
  }
  const differences: string[] = [];
  for (const key of new Set([...counts.keys(), ...expected.keys()])) {
    if ((counts.get(key) ?? 0) !== (expected.get(key) ?? 0))
      differences.push(
        `${key}: scheduler ${expected.get(key) ?? 0}, this analysis ${counts.get(key) ?? 0}`
      );
  }
  const free = nodes.filter(n => n.fits).length;
  if (scheduler.available !== null && free !== scheduler.available)
    differences.push(`available nodes: scheduler ${scheduler.available}, this analysis ${free}`);
  return { checked: true, matches: differences.length === 0, differences };
}

function fixes(
  pod: Pod,
  nodes: NodeVerdict[],
  podLevel: Blocker[],
  state: ClusterState,
  requests: Record<string, number>
): Fix[] {
  const out: Fix[] = [];
  const classes = (state.storageClasses ?? []).map(c => c.metadata.name);
  const advice: Partial<Record<ReasonKind, string>> = {
    topologySpread:
      'A topology spread constraint with whenUnsatisfiable: DoNotSchedule would be broken. Check maxSkew and which nodes the pod may use, or set whenUnsatisfiable: ScheduleAnyway.',
    volumeNodeAffinity:
      "The bound PersistentVolume can only be used from some nodes, often one zone. Run the pod where the volume is, or use a volume in the pod's zone.",
    volumeLimits:
      'The node has reached its limit of attached volumes. Use another node or fewer volumes per node.',
    other: "This plugin does not model this check yet, so this is the scheduler's own text.",
  };
  for (const b of podLevel) {
    const missingClass =
      b.kind === 'volumeBinding' &&
      /does not exist/.test(b.summary) &&
      /StorageClass/.test(b.summary);
    out.push({
      title: b.summary,
      detail:
        missingClass && classes.length
          ? `Use one of the existing StorageClasses: ${classes.join(
              ', '
            )}. A claim's storageClassName cannot be changed after creation, so recreate the claim.`
          : advice[b.kind] ??
            "The pod waits until its volumes can be bound. Check the claim's events for provisioning errors.",
    });
  }

  const impossible = (b: Blocker) =>
    b.kind === 'resources' &&
    b.requested !== undefined &&
    b.capacity !== undefined &&
    b.requested > b.capacity;
  const single = nodes.filter(
    n => !n.fits && n.blockers.length === 1 && !impossible(n.blockers[0])
  );
  const taints = new Map<string, { taint: Taint; nodes: string[] }>();
  for (const n of nodes)
    for (const b of n.blockers)
      if (b.kind === 'taint' && b.taint) {
        const key = taintText(b.taint);
        taints.set(key, { taint: b.taint, nodes: [...(taints.get(key)?.nodes ?? []), n.node] });
      }
  for (const [key, { taint, nodes: on }] of taints) {
    const controlPlane = CONTROL_PLANE_TAINTS.includes(taint.key);
    out.push({
      title: `${on.length === 1 ? on[0] : `${on.length} nodes`} ${
        on.length === 1 ? 'has' : 'have'
      } the taint ${key}`,
      detail: controlPlane
        ? 'This taint keeps workloads off control-plane nodes. Usually leave it and make room on worker nodes instead.'
        : 'If the pod is meant to run on these nodes, add a toleration. Otherwise the taint is doing its job.',
      snippet: controlPlane
        ? undefined
        : `tolerations:\n  - key: ${taint.key}\n    operator: ${taint.value ? 'Equal' : 'Exists'}${
            taint.value ? `\n    value: ${taint.value}` : ''
          }\n    effect: ${taint.effect}`,
    });
  }

  for (const [key, value] of Object.entries(pod.spec.nodeSelector ?? {})) {
    if (state.nodes.some(n => n.metadata.labels?.[key] === value)) continue;
    out.push({
      title: `No node has the label ${key}=${value}`,
      detail:
        'The node selector requires it. Label the node the pod should run on, or remove the selector.',
      snippet: `kubectl label node <node-name> ${key}=${value}`,
    });
  }

  for (const [resource, requested] of Object.entries(requests)) {
    const short = nodes.filter(n =>
      n.blockers.some(b => b.kind === 'resources' && b.resource === resource)
    );
    if (!requested || !short.length) continue;
    const frees = state.nodes.map(n => ({
      node: n.metadata.name,
      free: nodes.find(v => v.node === n.metadata.name)?.blockers.find(b => b.resource === resource)
        ?.free,
    }));
    const capacities = state.nodes.map(n =>
      parseQuantity(n.status?.allocatable?.[resource] ?? '0')
    );
    const largest = Math.max(...capacities);
    const best = frees
      .filter(f => f.free !== undefined)
      .sort((a, b) => (b.free ?? 0) - (a.free ?? 0))[0];
    out.push({
      title: `The pod requests ${formatResource(resource, requested)} ${resource}`,
      detail:
        requested > largest
          ? `No node has that much ${resource} even when empty. The largest node offers ${formatResource(
              resource,
              largest
            )}. Lower the request, or add a bigger node.`
          : `${
              best
                ? `The most free on a node short of it is ${formatResource(
                    resource,
                    Math.max(0, best.free ?? 0)
                  )} (${best.node}). `
                : ''
            }Lower the request, free up capacity, or add a node.`,
    });
  }

  const seenPorts = new Set<string>();
  for (const n of nodes)
    for (const b of n.blockers)
      if (b.kind === 'ports' && !seenPorts.has(b.summary)) {
        seenPorts.add(b.summary);
        out.push({
          title: `${b.summary} on ${n.node}`,
          detail:
            'Only one pod per node can use a host port. Pick another hostPort, run it on another node, or remove hostPort and use a Service.',
        });
      }

  const anti = nodes.flatMap(n =>
    n.blockers.filter(b => b.kind === 'podAntiAffinity').map(b => ({ node: n.node, b }))
  );
  if (anti.length) {
    out.push({
      title: `A pod anti-affinity rule blocks ${
        anti.length === 1 ? anti[0].node : `${anti.length} nodes`
      }`,
      detail:
        'Every eligible node already runs a matching pod. Add nodes, lower the replica count, or switch the rule to preferredDuringSchedulingIgnoredDuringExecution.',
    });
  }
  for (const n of nodes)
    if (n.blockers.some(b => b.kind === 'unschedulable')) {
      out.push({
        title: `${n.node} is cordoned`,
        detail: 'If the maintenance is finished, make it schedulable again.',
        snippet: `kubectl uncordon ${n.node}`,
      });
    }
  const candidates = rankNodes(single, state).filter(n => !controlPlaneTaintOnly(n));
  const last = out.filter(f => CONTROL_PLANE_TAINTS.some(key => f.title.includes(`taint ${key}`)));
  const ordered = [...out.filter(f => !last.includes(f)), ...last];
  out.length = 0;
  out.push(...ordered);
  if (candidates.length && !podLevel.length) {
    const n = candidates[0];
    out.unshift({
      title: `Closest fit: ${n.node}`,
      detail: `Only one thing blocks it: ${n.blockers[0].summary
        .charAt(0)
        .toLowerCase()}${n.blockers[0].summary.slice(1)}.`,
    });
  }
  return out;
}

export function isControlPlane(node: Node | undefined): boolean {
  if (!node) return false;
  const labels = node.metadata.labels ?? {};
  return (
    CONTROL_PLANE_TAINTS.some(key => key in labels) ||
    (node.spec?.taints ?? []).some(t => CONTROL_PLANE_TAINTS.includes(t.key))
  );
}

function controlPlaneTaintOnly(verdict: NodeVerdict) {
  return (
    verdict.blockers.length > 0 &&
    verdict.blockers.every(
      b => b.kind === 'taint' && b.taint && CONTROL_PLANE_TAINTS.includes(b.taint.key)
    )
  );
}

export function rankNodes(nodes: NodeVerdict[], state: ClusterState): NodeVerdict[] {
  const byName = new Map(state.nodes.map(n => [n.metadata.name, n]));
  const score = (v: NodeVerdict) =>
    (isControlPlane(byName.get(v.node)) ? 1000 : 0) +
    (v.blockers.some(b => b.kind === 'nodeAffinity') ? 100 : 0) +
    v.blockers.length;
  return nodes.filter(n => !n.fits).sort((a, b) => score(a) - score(b));
}

export function summarize(
  explanation: Explanation,
  state: ClusterState
): { main: string; closest: NodeVerdict | null } {
  if (explanation.gates.length)
    return { main: `Waiting for scheduling gates: ${explanation.gates.join(', ')}`, closest: null };
  if (explanation.podLevel.length) return { main: explanation.podLevel[0].summary, closest: null };
  if (explanation.nodes.length && explanation.nodes.every(n => n.fits))
    return { main: 'Every node fits now', closest: null };
  const closest = rankNodes(explanation.nodes, state)[0] ?? null;
  const blocker =
    closest?.blockers.find(
      b => !(b.kind === 'taint' && b.taint && CONTROL_PLANE_TAINTS.includes(b.taint.key))
    ) ?? closest?.blockers[0];
  if (closest && blocker) return { main: `${closest.node}: ${blocker.summary}`, closest };
  return {
    main: explanation.scheduler?.raw ?? 'The scheduler has not tried this pod yet',
    closest,
  };
}

export function explainPod(pod: Pod, state: ClusterState): Explanation {
  const scheduled = Boolean(pod.spec.nodeName);
  const message = latestSchedulingMessage(pod, state.events);
  const scheduler = message ? parseSchedulerMessage(message) : null;
  const gates = (pod.spec.schedulingGates ?? []).map(g => g.name);
  const unchecked = { checked: false, matches: false, differences: [] };
  if (scheduled)
    return {
      scheduled,
      podLevel: [],
      nodes: [],
      fixes: [],
      scheduler,
      agreement: unchecked,
      gates: [],
    };
  if (gates.length)
    return {
      scheduled,
      podLevel: [],
      nodes: [],
      fixes: [
        {
          title: `Remove the scheduling gate${gates.length === 1 ? '' : 's'} when the pod is ready`,
          detail:
            'Gates are usually removed by the controller that added them, such as a quota or provisioning system. Check that controller before removing a gate by hand.',
          snippet: `kubectl patch pod ${pod.metadata.name} -n ${pod.metadata.namespace} --type=json -p '[{"op":"remove","path":"/spec/schedulingGates"}]'`,
        },
      ],
      scheduler,
      agreement: unchecked,
      gates,
    };
  const requests = podRequests(pod);
  const podLevel = volumeBlockers(pod, state);
  const nodes = state.nodes.map(node => {
    const blockers = checkNode(pod, node, state, requests);
    return { node: node.metadata.name, fits: blockers.length === 0, blockers };
  });
  const agreement = scheduler ? compare(scheduler, nodes, podLevel) : unchecked;
  if (scheduler) {
    const modelled = new Set(
      nodes.flatMap(n => n.blockers.map(b => b.kind)).concat(podLevel.map(b => b.kind))
    );
    for (const r of scheduler.reasons) {
      if (
        !modelled.has(r.kind) &&
        (r.kind === 'topologySpread' ||
          r.kind === 'volumeNodeAffinity' ||
          r.kind === 'volumeLimits' ||
          r.kind === 'other')
      ) {
        podLevel.push({
          kind: r.kind,
          summary: `Scheduler: ${r.count !== null ? `${r.count} ` : ''}${r.text}`,
        });
      }
    }
  }
  return {
    scheduled,
    podLevel,
    nodes,
    fixes: fixes(pod, nodes, podLevel, state, requests),
    scheduler,
    agreement,
    gates,
  };
}
