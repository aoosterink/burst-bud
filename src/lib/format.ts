export const pad2 = (n: number) => String(n).padStart(2, '0');

export function clockTime(ms: number, withMs = false) {
  const d = new Date(ms);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base;
}

export function shortDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function seconds(ms: number) {
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Gap presets for the − / + control, in ms. */
export const GAP_STEPS = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000];

export function stepGap(current: number, dir: 1 | -1) {
  if (dir === 1) return GAP_STEPS.find((s) => s > current) ?? current;
  return [...GAP_STEPS].reverse().find((s) => s < current) ?? current;
}
