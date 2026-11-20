export type ReasonKind =
  | 'resources'
  | 'taint'
  | 'nodeAffinity'
  | 'podAffinity'
  | 'podAntiAffinity'
  | 'ports'
  | 'unschedulable'
  | 'topologySpread'
  | 'volumeNodeAffinity'
  | 'volumeLimits'
  | 'volumeBinding'
  | 'notReady'
  | 'other';

export interface SchedulerReason {
  count: number | null;
  text: string;
  kind: ReasonKind;
  resource?: string;
  taint?: string;
}

export interface SchedulerMessage {
  available: number | null;
  total: number | null;
  reasons: SchedulerReason[];
  raw: string;
}

const RULES: [RegExp, ReasonKind][] = [
  [/^Insufficient (\S+)/i, 'resources'],
  [/^Too many pods/i, 'resources'],
  [/untolerated taint/i, 'taint'],
  [/didn't match Pod's node affinity\/selector|didn't match node selector/i, 'nodeAffinity'],
  [/didn't match pod anti-affinity rules|existing pods anti-affinity rules/i, 'podAntiAffinity'],
  [/didn't match pod affinity rules/i, 'podAffinity'],
  [/didn't have free ports/i, 'ports'],
  [/were unschedulable/i, 'unschedulable'],
  [/topology spread constraints/i, 'topologySpread'],
  [/volume node affinity conflict/i, 'volumeNodeAffinity'],
  [/exceed max volume count/i, 'volumeLimits'],
  [
    /unbound immediate PersistentVolumeClaims|didn't find available persistent volumes|persistentvolumeclaim .* not found|waiting for (?:first consumer|volume)/i,
    'volumeBinding',
  ],
  [/not-ready|unreachable/i, 'notReady'],
];

export function classify(text: string): Omit<SchedulerReason, 'count' | 'text'> {
  const taint = text.match(/untolerated taint\(?s?\)?\s*\{([^}]*)\}/i)?.[1]?.trim();
  if (taint && /node\.kubernetes\.io\/(not-ready|unreachable)/.test(taint))
    return { kind: 'notReady', taint };
  for (const [pattern, kind] of RULES) {
    const match = text.match(pattern);
    if (!match) continue;
    if (kind === 'resources')
      return { kind, resource: /^Too many pods/i.test(text) ? 'pods' : match[1] };
    if (kind === 'taint') return taint ? { kind, taint } : { kind };
    return { kind };
  }
  return { kind: 'other' };
}

function splitReasons(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

export function parseSchedulerMessage(message: string): SchedulerMessage {
  const raw = message.trim();
  const withoutPreemption = raw.split(/\.\s*preemption:/i)[0];
  const header = withoutPreemption.match(/^(\d+)\/(\d+) nodes are available:?\s*([\s\S]*)$/i);
  if (!header) {
    const text = withoutPreemption.replace(/\.$/, '');
    return {
      available: null,
      total: null,
      reasons: text ? [{ count: null, text, ...classify(text) }] : [],
      raw,
    };
  }
  const [, available, total, body] = header;
  const reasons = splitReasons(body.replace(/\.$/, '')).map(part => {
    const counted = part.match(/^(\d+)\s+([\s\S]*)$/);
    const text = (counted ? counted[2] : part).replace(/\.$/, '').trim();
    return { count: counted ? Number(counted[1]) : null, text, ...classify(text) };
  });
  return { available: Number(available), total: Number(total), reasons, raw };
}
