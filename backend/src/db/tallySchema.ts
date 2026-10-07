/**
 * TallyPrime schema marker (DynamoDB backend).
 *
 * DynamoDB is schemaless — no tables to create. This module is kept so
 * existing imports keep working; ensureTallySchema() is a no-op.
 */
export const TALLY_MIGRATION_NAME = "v4_tally_integration";

export function ensureTallySchema(): void {
  // No-op on DynamoDB.
}
