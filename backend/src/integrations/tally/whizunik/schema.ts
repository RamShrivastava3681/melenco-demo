/**
 * WhizUnik Cloud API schema marker (DynamoDB backend).
 *
 * DynamoDB is schemaless — no tables to create. This module is kept so
 * existing imports keep working; ensureWhizunikSchema() is a no-op.
 */
export const WHIZUNIK_MIGRATION_NAME = "v5_whizunik_cloud_api";

export function ensureWhizunikSchema(): void {
  // No-op on DynamoDB.
}
