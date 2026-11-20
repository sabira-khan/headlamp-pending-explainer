const BINARY: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};
const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

export function parseQuantity(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  const match = String(value)
    .trim()
    .match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/);
  if (!match) return NaN;
  const [, number, suffix] = match;
  const factor = BINARY[suffix] ?? DECIMAL[suffix];
  return factor === undefined ? NaN : Number(number) * factor;
}

function trim(n: number, digits: number) {
  return Number(n.toFixed(digits)).toString();
}

export function formatCpu(cores: number): string {
  if (cores > 0 && cores < 1) return `${Math.round(cores * 1000)}m`;
  return trim(cores, 2);
}

export function formatBytes(bytes: number): string {
  const units: [string, number][] = [
    ['Ti', 2 ** 40],
    ['Gi', 2 ** 30],
    ['Mi', 2 ** 20],
    ['Ki', 2 ** 10],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(bytes) >= size) return `${trim(bytes / size, 1)}${unit}`;
  }
  return `${Math.round(bytes)}`;
}

export function formatResource(resource: string, value: number): string {
  if (resource === 'cpu') return formatCpu(value);
  if (
    resource === 'memory' ||
    resource === 'ephemeral-storage' ||
    resource.startsWith('hugepages-')
  )
    return formatBytes(value);
  return trim(value, 2);
}
