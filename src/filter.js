import { LEVELS, levelRank } from "./levels.js";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

/** Thrown when a caller supplies an unusable filter parameter. */
export class FilterError extends Error {}

/**
 * @typedef {object} Filter
 * @property {number} after only entries with a greater seq
 * @property {string | null} levelMin minimum level, or null for all
 * @property {RegExp | null} include text must match
 * @property {RegExp | null} exclude text must not match
 * @property {RegExp | null} source source must match
 * @property {number} limit newest entries kept
 */

/**
 * Validates raw (string or typed) query parameters into a filter the store
 * understands. Shared by the HTTP API and the MCP tools so both accept exactly
 * the same vocabulary: `after`, `level_min`, `include`, `exclude`, `source`,
 * `limit`.
 *
 * @param {Record<string, unknown>} [raw]
 * @returns {Filter}
 */
export function parseFilter(raw = {}) {
  const levelMin = emptyToNull(raw.level_min);
  if (levelMin !== null && !LEVELS.includes(levelMin)) {
    throw new FilterError(`level_min must be one of: ${LEVELS.join(", ")}`);
  }
  return {
    after: nonNegativeInt(raw.after, 0, "after"),
    levelMin,
    include: toRegExp(raw.include, "include"),
    exclude: toRegExp(raw.exclude, "exclude"),
    source: toRegExp(raw.source, "source"),
    limit: Math.min(nonNegativeInt(raw.limit, DEFAULT_LIMIT, "limit") || DEFAULT_LIMIT, MAX_LIMIT),
  };
}

/**
 * @param {import('./store.js').Entry} entry
 * @param {Filter} filter
 * @returns {boolean} whether the entry passes the filter (ignoring `after` and `limit`).
 */
export function matches(entry, { levelMin, include, exclude, source }) {
  if (levelMin && levelRank(entry.level) < levelRank(levelMin)) return false;
  if (source && !source.test(entry.source ?? "")) return false;
  if (include && !include.test(entry.text)) return false;
  if (exclude?.test(entry.text)) return false;
  return true;
}

/** @param {unknown} value @returns {string | null} */
function emptyToNull(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

/** @param {unknown} value @param {string} name @returns {RegExp | null} */
function toRegExp(value, name) {
  const pattern = emptyToNull(value);
  if (pattern === null) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    throw new FilterError(`${name} is not a valid regular expression: ${pattern}`);
  }
}

/** @param {unknown} value @param {number} fallback @param {string} name @returns {number} */
function nonNegativeInt(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new FilterError(`${name} must be a non-negative integer`);
  }
  return n;
}
