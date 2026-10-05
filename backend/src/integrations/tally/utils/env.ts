/** Central env-based configuration for the Tally integration. */

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  pairingCodeTtlMinutes: intEnv("TALLY_PAIRING_CODE_TTL_MINUTES", 10),
  pairingMaxAttempts: intEnv("TALLY_PAIRING_MAX_ATTEMPTS", 5),

  batchMaxRecords: intEnv("TALLY_BATCH_MAX_RECORDS", 500),
  batchMaxBytes: intEnv("TALLY_BATCH_MAX_BYTES", 2 * 1024 * 1024),

  rateLimitBatchPerMin: intEnv("TALLY_RATE_BATCH_PER_MIN", 120),
  rateLimitHeartbeatPerMin: intEnv("TALLY_RATE_HEARTBEAT_PER_MIN", 60),
  rateLimitConnectPerHour: intEnv("TALLY_RATE_CONNECT_PER_HOUR", 10),
  rateLimitPairingPer10Min: intEnv("TALLY_RATE_PAIRING_PER_10MIN", 5),
  rateLimitDefaultPerMin: intEnv("TALLY_RATE_DEFAULT_PER_MIN", 240),

  hmacRequired: boolEnv("TALLY_HMAC_REQUIRED", false),
  requestTimestampWindowSec: intEnv("TALLY_REQUEST_TIMESTAMP_WINDOW_SEC", 300),
  heartbeatStaleMinutes: intEnv("TALLY_HEARTBEAT_STALE_MINUTES", 10),

  rawRetentionDays: intEnv("TALLY_RAW_RETENTION_DAYS", 30),
  rawRetentionCleanupIntervalMin: intEnv("TALLY_RAW_RETENTION_CLEANUP_INTERVAL_MIN", 60),
};
