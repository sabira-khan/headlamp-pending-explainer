import { describe, expect, it } from 'vitest';
import { parseSchedulerMessage } from './parse';
import { formatBytes, formatCpu, parseQuantity } from './quantity';

describe('parseSchedulerMessage', () => {
  it('reads counts and reasons from a v1.37 message and drops the preemption part', () => {
    const m = parseSchedulerMessage(
      "0/3 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 2 node(s) had untolerated taint(s). preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling."
    );
    expect(m.available).toBe(0);
    expect(m.total).toBe(3);
    expect(m.reasons.map(r => [r.count, r.kind])).toEqual([
      [1, 'nodeAffinity'],
      [2, 'taint'],
    ]);
  });

  it('keeps the resource name for insufficient resources', () => {
    const m = parseSchedulerMessage(
      '0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient cpu, 1 Insufficient nvidia.com/gpu. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.'
    );
    expect(m.reasons.filter(r => r.kind === 'resources').map(r => r.resource)).toEqual([
      'cpu',
      'nvidia.com/gpu',
    ]);
  });

  it('reads taint details from older messages without splitting on commas inside braces', () => {
    const m = parseSchedulerMessage(
      '0/4 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 1 node(s) had untolerated taint {node.kubernetes.io/not-ready: }, 2 Too many pods.'
    );
    expect(m.reasons.map(r => [r.count, r.kind, r.taint ?? r.resource])).toEqual([
      [1, 'taint', 'node-role.kubernetes.io/control-plane:'],
      [1, 'notReady', 'node.kubernetes.io/not-ready:'],
      [2, 'resources', 'pods'],
    ]);
  });

  it('classifies the other filter plugins', () => {
    const kinds = [
      "1 node(s) didn't have free ports for the requested pod ports",
      "1 node(s) didn't match pod anti-affinity rules",
      "1 node(s) didn't satisfy existing pods anti-affinity rules",
      "1 node(s) didn't match pod affinity rules",
      '1 node(s) were unschedulable',
      "1 node(s) didn't match pod topology spread constraints",
      '1 node(s) had volume node affinity conflict',
      '1 node(s) exceed max volume count',
      '1 something new',
    ].map(text => parseSchedulerMessage(`0/1 nodes are available: ${text}.`).reasons[0].kind);
    expect(kinds).toEqual([
      'ports',
      'podAntiAffinity',
      'podAntiAffinity',
      'podAffinity',
      'unschedulable',
      'topologySpread',
      'volumeNodeAffinity',
      'volumeLimits',
      'other',
    ]);
  });

  it('handles messages that fail before any node is checked', () => {
    const m = parseSchedulerMessage(
      '0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims. not found'
    );
    expect(m.reasons).toHaveLength(1);
    expect(m.reasons[0].count).toBeNull();
    expect(m.reasons[0].kind).toBe('volumeBinding');
    expect(parseSchedulerMessage('persistentvolumeclaim "data" not found').reasons[0].kind).toBe(
      'volumeBinding'
    );
  });
});

describe('quantities', () => {
  it('parses and formats CPU and memory', () => {
    expect(parseQuantity('250m')).toBe(0.25);
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('1Gi')).toBe(2 ** 30);
    expect(parseQuantity('128974848')).toBe(128974848);
    expect(parseQuantity('1e3')).toBe(1000);
    expect(parseQuantity('nonsense')).toBeNaN();
    expect(formatCpu(0.25)).toBe('250m');
    expect(formatCpu(1.85)).toBe('1.85');
    expect(formatBytes(200 * 2 ** 30)).toBe('200Gi');
  });
});
