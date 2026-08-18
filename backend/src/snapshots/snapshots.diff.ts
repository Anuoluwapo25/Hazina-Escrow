/**
 * snapshots.diff.ts — structural diff between two snapshots (#600).
 *
 * "14 wallets added, 3 removed, 2 balances changed" is usually worth more than
 * either snapshot on its own, and it is cheap to compute once history exists.
 *
 * ## Output shape (stable — treat as API)
 *
 * ```jsonc
 * {
 *   "identical": false,
 *   "summary": { "added": 14, "removed": 3, "changed": 2 },
 *   "entries": [
 *     { "path": "wallets[GABC…]", "op": "added",   "after": { … } },
 *     { "path": "wallets[GXYZ…]", "op": "removed", "before": { … } },
 *     { "path": "totalTvl",       "op": "changed", "before": 1, "after": 2 }
 *   ],
 *   "truncated": false
 * }
 * ```
 *
 * - `entries` is sorted by `path`, so the same pair of payloads always produces
 *   byte-identical output — diffs can themselves be hashed and quoted.
 * - `path` is a dot/bracket path. Arrays of objects that carry a stable
 *   identity field (see `IDENTITY_KEYS`) are matched by that identity —
 *   `wallets[GABC…]` — so one insertion at the top of a list does not read as
 *   "every row changed". Any other array is matched positionally: `points[3]`.
 * - A changed leaf reports `before` and `after`; an added leaf reports only
 *   `after`, a removed leaf only `before`.
 * - `truncated` is true when the diff hit `maxEntries`; `summary` still counts
 *   every difference found.
 */

const IDENTITY_KEYS = ['id', 'address', 'wallet', 'account', 'symbol', 'pool', 'key', 'name'];

/** Entries beyond this are counted but not listed, so a diff response stays bounded. */
export const DEFAULT_MAX_DIFF_ENTRIES = 500;

export type DiffOp = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  path: string;
  op: DiffOp;
  before?: unknown;
  after?: unknown;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
}

export interface StructuralDiff {
  identical: boolean;
  summary: DiffSummary;
  entries: DiffEntry[];
  truncated: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pick the field that identifies elements of an object array, if any: it must
 * be present on every element and unique across them.
 */
function findIdentityKey(items: unknown[]): string | undefined {
  if (items.length === 0 || !items.every(isPlainObject)) return undefined;
  const objects = items as Record<string, unknown>[];
  return IDENTITY_KEYS.find(key => {
    const values = objects.map(item => item[key]);
    if (values.some(value => typeof value !== 'string' && typeof value !== 'number')) return false;
    return new Set(values.map(String)).size === objects.length;
  });
}

function joinPath(base: string, segment: string): string {
  return base ? `${base}.${segment}` : segment;
}

class DiffCollector {
  readonly summary: DiffSummary = { added: 0, removed: 0, changed: 0 };
  readonly entries: DiffEntry[] = [];
  truncated = false;

  constructor(private readonly maxEntries: number) {}

  add(entry: DiffEntry): void {
    this.summary[entry.op] += 1;
    if (this.entries.length >= this.maxEntries) {
      this.truncated = true;
      return;
    }
    this.entries.push(entry);
  }
}

function walkAdded(value: unknown, path: string, out: DiffCollector): void {
  out.add({ path, op: 'added', after: value });
}

function walkRemoved(value: unknown, path: string, out: DiffCollector): void {
  out.add({ path, op: 'removed', before: value });
}

function diffArrays(before: unknown[], after: unknown[], path: string, out: DiffCollector): void {
  const identityKey = findIdentityKey(before) ?? findIdentityKey(after);

  if (identityKey) {
    const index = (items: unknown[]): Map<string, Record<string, unknown>> =>
      new Map(
        items
          .filter(isPlainObject)
          .map(item => [String((item as Record<string, unknown>)[identityKey]), item]),
      );
    const beforeById = index(before);
    const afterById = index(after);
    const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();

    for (const id of ids) {
      const child = `${path}[${id}]`;
      const beforeItem = beforeById.get(id);
      const afterItem = afterById.get(id);
      if (beforeItem === undefined) walkAdded(afterItem, child, out);
      else if (afterItem === undefined) walkRemoved(beforeItem, child, out);
      else diffValues(beforeItem, afterItem, child, out);
    }
    return;
  }

  const length = Math.max(before.length, after.length);
  for (let i = 0; i < length; i += 1) {
    const child = `${path}[${i}]`;
    if (i >= before.length) walkAdded(after[i], child, out);
    else if (i >= after.length) walkRemoved(before[i], child, out);
    else diffValues(before[i], after[i], child, out);
  }
}

function diffValues(before: unknown, after: unknown, path: string, out: DiffCollector): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(before, after, path, out);
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const child = joinPath(path, key);
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (!hasBefore) walkAdded(after[key], child, out);
      else if (!hasAfter) walkRemoved(before[key], child, out);
      else diffValues(before[key], after[key], child, out);
    }
    return;
  }

  if (!Object.is(before, after)) {
    out.add({ path: path || '<root>', op: 'changed', before, after });
  }
}

/** Structurally diff two payloads. See the module docblock for the shape. */
export function diffPayloads(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  maxEntries: number = DEFAULT_MAX_DIFF_ENTRIES,
): StructuralDiff {
  const collector = new DiffCollector(Math.max(1, maxEntries));
  diffValues(before, after, '', collector);
  collector.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const { added, removed, changed } = collector.summary;
  return {
    identical: added + removed + changed === 0,
    summary: collector.summary,
    entries: collector.entries,
    truncated: collector.truncated,
  };
}
