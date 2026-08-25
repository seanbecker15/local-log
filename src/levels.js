/**
 * Canonical levels, lowest to highest severity. Every ingested level is
 * normalized onto one of these so `level_min` filtering works regardless of
 * which logger produced the record.
 */
export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

const RANK = new Map(LEVELS.map((level, index) => [level, index]));
const INFO_RANK = LEVELS.indexOf("info");

const ALIASES = {
  log: "info",
  notice: "info",
  success: "info",
  http: "debug",
  verbose: "trace",
  silly: "trace",
  warning: "warn",
  err: "error",
  critical: "fatal",
  crit: "fatal",
  emerg: "fatal",
  emergency: "fatal",
  alert: "fatal",
  panic: "fatal",
};

/**
 * Maps any logger's level onto a canonical level. Understands names (pino,
 * winston, consola, Python `WARNING`/`CRITICAL`, syslog), pino/bunyan numerics
 * (10–60) and syslog severities (0–7). Unknown values become "info".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLevel(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return fromNumber(value);
  }
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (RANK.has(key)) return key;
    if (ALIASES[key]) return ALIASES[key];
    const numeric = Number(key);
    if (key !== "" && Number.isFinite(numeric)) return fromNumber(numeric);
  }
  return "info";
}

/** @param {string} level @returns {number} position in LEVELS; unknown levels rank as "info". */
export function levelRank(level) {
  return RANK.get(level) ?? INFO_RANK;
}

/** @param {number} n @returns {string} */
function fromNumber(n) {
  if (n >= 10) {
    // pino / bunyan: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
    if (n >= 60) return "fatal";
    if (n >= 50) return "error";
    if (n >= 40) return "warn";
    if (n >= 30) return "info";
    if (n >= 20) return "debug";
    return "trace";
  }
  // syslog severities: 0 emerg … 3 err, 4 warning, 5 notice, 6 info, 7 debug
  if (n <= 2) return "fatal";
  if (n === 3) return "error";
  if (n === 4) return "warn";
  if (n <= 6) return "info";
  return "debug";
}
