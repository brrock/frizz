// Frizz's one duration grammar (CLAUDE.md § Durations): the unit is a suffix glued to the number,
// `ms s m h d w mo y`, and a compound reading joins at most two units with one space: `40m`,
// `2h 35m`, `3d 4h`. Hours are `h`, never `hr`; months are `mo` because `m` is minutes.

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const W = 7 * D;
const MO = 30 * D;
const Y = 365 * D;

export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < S) return `${Math.round(v)}ms`;
  if (v < M) return `${Math.floor(v / S)}s`;
  if (v < H) return `${Math.floor(v / M)}m`;
  if (v < D) return pair(Math.floor(v / H), "h", Math.floor((v % H) / M), "m");
  if (v < W) return pair(Math.floor(v / D), "d", Math.floor((v % D) / H), "h");
  if (v < 5 * W) return `${Math.floor(v / W)}w`;
  if (v < Y) return `${Math.max(1, Math.floor(v / MO))}mo`;
  return `${Math.floor(v / Y)}y`;
}

function pair(a: number, ua: string, b: number, ub: string): string {
  return b === 0 ? `${a}${ua}` : `${a}${ua} ${b}${ub}`;
}

/** How long ago `iso` was, in the house grammar. A reading under a minute says `now`. */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  return ms < M ? "now" : formatDuration(ms);
}

/** How long until `iso`, for a snooze. */
export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  return ms <= 0 ? "now" : formatDuration(ms);
}
