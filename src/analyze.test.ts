import { describe, expect, it } from 'vitest';
import events from './__fixtures__/events.json';
import nodes from './__fixtures__/nodes.json';
import pods from './__fixtures__/pods.json';
import pvcs from './__fixtures__/pvcs.json';
import storageClasses from './__fixtures__/storageclasses.json';
import { explainPod, summarize, tolerates } from './analyze';
import type { ClusterState, Pod } from './kube';

const state: ClusterState = {
  nodes: nodes.items as ClusterState['nodes'],
  pods: pods.items as Pod[],
  pvcs: pvcs.items as ClusterState['pvcs'],
  storageClasses: storageClasses.items as ClusterState['storageClasses'],
  events: events.items as ClusterState['events'],
};
const pending = state.pods.filter(p => p.metadata.namespace === 'lab' && !p.spec.nodeName);
const pod = (prefix: string) => pending.find(p => p.metadata.name.startsWith(prefix))!;
const reasons = (prefix: string) =>
  Object.fromEntries(
    explainPod(pod(prefix), state).nodes.map(n => [n.node, n.blockers.map(b => b.summary)])
  );

describe('agreement with the real scheduler', () => {
  it('has pending pods from the kind cluster to check', () => {
    expect(pending.length).toBe(9);
  });

  for (const p of pending) {
    it(`matches the scheduler's counts for ${p.metadata.name}`, () => {
      const explanation = explainPod(p, state);
      expect(explanation.scheduler).not.toBeNull();
      expect(explanation.agreement.differences).toEqual([]);
      expect(explanation.agreement.matches).toBe(true);
    });
  }
});

describe('per-node explanations', () => {
  it('names the taints the scheduler only counts, and every other blocker on each node', () => {
    const cpu = expect.stringMatching(
      /^Insufficient cpu: pod requests 64, node has [\d.]+m? free$/
    );
    expect(reasons('too-much-cpu')).toEqual({
      'pending-lab-control-plane': [
        'Taint node-role.kubernetes.io/control-plane:NoSchedule is not tolerated',
        cpu,
      ],
      'pending-lab-worker': [cpu],
      'pending-lab-worker2': ['Taint dedicated=gpu:NoSchedule is not tolerated', cpu],
    });
  });

  it('suggests a toleration for custom taints but not for the control-plane taint', () => {
    const fixes = explainPod(pod('too-much-cpu'), state).fixes;
    const gpu = fixes.find(f => f.title.includes('dedicated=gpu'))!;
    expect(gpu.snippet).toBe(
      'tolerations:\n  - key: dedicated\n    operator: Equal\n    value: gpu\n    effect: NoSchedule'
    );
    expect(fixes.find(f => f.title.includes('control-plane'))?.snippet).toBeUndefined();
    expect(fixes.find(f => f.title.startsWith('The pod requests 64 cpu'))?.detail).toMatch(
      /No node has that much cpu even when empty/
    );
    expect(fixes.some(f => f.title.startsWith('Closest fit'))).toBe(false);
  });

  it('explains node selectors that no node satisfies', () => {
    const e = explainPod(pod('no-matching-node'), state);
    expect(e.nodes.find(n => n.node === 'pending-lab-worker')?.blockers[0].summary).toBe(
      'Node selector does not match: disktype=ssd (node has no such label)'
    );
    expect(e.fixes.find(f => f.title === 'No node has the label disktype=ssd')?.snippet).toBe(
      'kubectl label node <node-name> disktype=ssd'
    );
  });

  it('points at the pod holding a host port and the closest fit', () => {
    const e = explainPod(pod('host-port'), state);
    const worker = e.nodes.find(n => n.node === 'pending-lab-worker')!;
    expect(worker.blockers[0].summary).toMatch(
      /^Host port 8080\/TCP is already used by lab\/host-port-/
    );
    expect(e.fixes[0].title).toBe('Closest fit: pending-lab-worker');
  });

  it('names the pod behind an anti-affinity conflict', () => {
    const worker = explainPod(pod('spread-out'), state).nodes.find(
      n => n.node === 'pending-lab-worker'
    )!;
    expect(worker.blockers[0].summary).toMatch(
      /^Anti-affinity rule: lab\/spread-out-\S+ already runs in the same kubernetes.io\/hostname domain$/
    );
  });

  it('reports a claim whose StorageClass does not exist, with the classes that do', () => {
    const e = explainPod(pod('waits-for-volume'), state);
    expect(e.podLevel.map(b => b.summary)).toEqual([
      'PersistentVolumeClaim data uses StorageClass does-not-exist, which does not exist',
    ]);
    expect(e.fixes[0].detail).toMatch(/existing StorageClasses: standard/);
  });

  it('skips scheduled pods', () => {
    const running = state.pods.find(p => p.metadata.namespace === 'lab' && p.spec.nodeName)!;
    expect(explainPod(running, state).scheduled).toBe(true);
  });
});

describe('edge cases', () => {
  const node = (name: string, extra: Partial<ClusterState['nodes'][0]> = {}) => ({
    metadata: { name, labels: { 'kubernetes.io/hostname': name } },
    status: { allocatable: { cpu: '2', memory: '4Gi', pods: '110' } },
    ...extra,
  });
  const base = (spec: Partial<Pod['spec']> = {}): Pod => ({
    metadata: { name: 'p', namespace: 'default', uid: 'p' },
    spec: { containers: [{ name: 'c' }], ...spec },
  });

  it('matches tolerations the way the scheduler does', () => {
    const taint = { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' as const };
    expect(tolerates([{ operator: 'Exists' }], taint)).toBe(true);
    expect(tolerates([{ key: 'dedicated', operator: 'Exists' }], taint)).toBe(true);
    expect(tolerates([{ key: 'dedicated', value: 'gpu' }], taint)).toBe(true);
    expect(tolerates([{ key: 'dedicated', value: 'cpu' }], taint)).toBe(false);
    expect(tolerates([{ key: 'dedicated', value: 'gpu', effect: 'NoExecute' }], taint)).toBe(false);
  });

  it('reports cordoned nodes, counts init containers and ignores finished pods', () => {
    const cordoned = node('a', {
      spec: {
        unschedulable: true,
        taints: [{ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' }],
      },
    });
    const busy = node('b');
    const done: Pod = {
      metadata: { name: 'old', namespace: 'default', uid: 'old' },
      spec: { nodeName: 'b', containers: [{ name: 'c', resources: { requests: { cpu: '2' } } }] },
      status: { phase: 'Succeeded' },
    };
    const p = base({
      initContainers: [{ name: 'i', resources: { requests: { cpu: '1500m' } } }],
      containers: [{ name: 'c', resources: { requests: { cpu: '500m' } } }],
    });
    const e = explainPod(p, { nodes: [cordoned, busy], pods: [done] });
    expect(e.nodes.map(n => n.blockers.map(b => b.kind))).toEqual([['unschedulable'], []]);
    expect(e.fixes.find(f => f.snippet === 'kubectl uncordon a')).toBeTruthy();
  });

  it('evaluates required node affinity expressions', () => {
    const zoned = node('z', { metadata: { name: 'z', labels: { zone: 'b', size: '8' } } });
    const p = base({
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
              { matchExpressions: [{ key: 'zone', operator: 'In', values: ['a'] }] },
              { matchExpressions: [{ key: 'size', operator: 'Gt', values: ['4'] }] },
            ],
          },
        },
      },
    });
    expect(explainPod(p, { nodes: [zoned], pods: [] }).nodes[0].fits).toBe(true);
    const strict = base({
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
              { matchExpressions: [{ key: 'zone', operator: 'NotIn', values: ['b'] }] },
            ],
          },
        },
      },
    });
    expect(explainPod(strict, { nodes: [zoned], pods: [] }).nodes[0].blockers[0].kind).toBe(
      'nodeAffinity'
    );
  });

  it('lets the first pod of a self-affine group schedule', () => {
    const p = base({
      affinity: {
        podAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            { labelSelector: { matchLabels: { app: 'x' } }, topologyKey: 'kubernetes.io/hostname' },
          ],
        },
      },
    });
    p.metadata.labels = { app: 'x' };
    expect(explainPod(p, { nodes: [node('a')], pods: [] }).nodes[0].fits).toBe(true);
    p.metadata.labels = { app: 'y' };
    expect(explainPod(p, { nodes: [node('a')], pods: [] }).nodes[0].blockers[0].kind).toBe(
      'podAffinity'
    );
  });

  it('passes through reasons it does not model', () => {
    const p = base();
    p.status = {
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message:
            "0/1 nodes are available: 1 node(s) didn't match pod topology spread constraints.",
        },
      ],
    };
    const e = explainPod(p, { nodes: [node('a')], pods: [] });
    expect(e.podLevel[0].summary).toBe(
      "Scheduler: 1 node(s) didn't match pod topology spread constraints"
    );
    expect(e.fixes.find(f => f.title.startsWith('Scheduler:'))?.detail).toMatch(
      /whenUnsatisfiable: ScheduleAnyway/
    );
  });
});

describe('summaries for the pending pods list', () => {
  it('picks a worker over a control-plane node and names its real blocker', () => {
    const cases = Object.fromEntries(
      pending.map(p => [
        p.metadata.name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, ''),
        summarize(explainPod(p, state), state),
      ])
    );
    expect(cases['too-much-cpu'].main).toMatch(/^pending-lab-worker: Insufficient cpu/);
    expect(cases['gpu-node-only'].main).toBe(
      'pending-lab-worker2: Taint dedicated=gpu:NoSchedule is not tolerated'
    );
    expect(cases['no-matching-node'].main).toBe(
      'pending-lab-worker: Node selector does not match: disktype=ssd (node has no such label)'
    );
    expect(cases['spread-out'].main).toMatch(/^pending-lab-worker: Anti-affinity rule/);
    expect(cases['host-port'].main).toMatch(/^pending-lab-worker: Host port 8080\/TCP/);
    expect(cases['waits-for-volume']).toEqual({
      main: 'PersistentVolumeClaim data uses StorageClass does-not-exist, which does not exist',
      closest: null,
    });
  });

  it('suggests the node the pod targets as the closest fit', () => {
    expect(explainPod(pod('gpu-node-only'), state).fixes[0]).toEqual({
      title: 'Closest fit: pending-lab-worker2',
      detail: 'Only one thing blocks it: taint dedicated=gpu:NoSchedule is not tolerated.',
    });
  });

  it('lists the control-plane taint last and never as the closest fit', () => {
    const fixes = explainPod(pod('spread-out'), state).fixes.map(f => f.title);
    expect(fixes.at(-1)).toMatch(/control-plane/);
    expect(fixes.some(f => f === 'Closest fit: pending-lab-control-plane')).toBe(false);
  });
});
