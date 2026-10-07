/**
 * Swagger / OpenAPI 3.0 document for the Tally API.
 * Base URL: https://excel.frillchills.com/api
 * Served as JSON at GET /api/integrations/tally/openapi.json
 */
export const whizunikOpenApi = {
  openapi: "3.0.3",
  info: {
    title: "Tally API — TallyPrime Integration",
    version: "1.0.0",
    description:
      "Cloud API for the tally-connector desktop agent (outbound HTTPS only; the connector never exposes ports). " +
      "Base URL: https://excel.frillchills.com/api. All endpoints return JSON. Send X-Request-Id for tracing. HTTPS is required in production.",
  },
  servers: [{ url: "https://excel.frillchills.com/api", description: "Production" }],
  security: [],
  paths: {
    "/api/integrations/tally/connect": {
      post: {
        summary: "Pair a desktop connector with a pairing code",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ConnectRequest" },
              example: {
                pairingCode: "WZK-AB12-CD34",
                deviceId: "string-uuid",
                deviceName: "DESKTOP-ABC",
                appVersion: "1.0.0",
                protocolVersion: "1.0",
                company: { name: "Demo Company", tallyGuid: "optional-guid" },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Paired",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ConnectResponse" },
                example: {
                  connectorId: "wz-connector-001",
                  accessToken: "jwt-access-token",
                  refreshToken: "jwt-refresh-token",
                  accessTokenExpiresAt: "2026-10-05T12:00:00Z",
                  tenant: { id: "tenant-1", name: "Tenant Name" },
                  companyMapping: { tallyCompanyGuid: "tally-guid", whizunikCompanyId: "whiz-company-1" },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
          "429": { $ref: "#/components/responses/Error429" },
          "500": { $ref: "#/components/responses/Error500" },
        },
      },
    },
    "/api/integrations/tally/token": {
      post: {
        summary: "Refresh an access token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TokenRequest" },
              example: { refreshToken: "jwt-refresh-token", deviceId: "string-uuid", connectorId: "wz-connector-001" },
            },
          },
        },
        responses: {
          "200": {
            description: "New tokens (same shape as connect)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ConnectResponse" } } },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
          "429": { $ref: "#/components/responses/Error429" },
          "500": { $ref: "#/components/responses/Error500" },
        },
      },
    },
    "/api/integrations/tally/sync/batch": {
      post: {
        summary: "Upload a sync batch (batchId is the idempotency key)",
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/XRequestId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BatchRequest" },
              example: {
                batchId: "sync_123_batch_00037",
                requestId: "req_xxx",
                syncId: "sync_123",
                deviceId: "string-uuid",
                companyId: "whiz-company-1",
                entityType: "sales_voucher",
                batchNumber: 1,
                totalBatches: 10,
                records: [
                  {
                    source: "tally",
                    sourceCompanyId: "...",
                    entityType: "sales_voucher",
                    sourceObjectId: "...",
                    sourceVoucherNumber: "...",
                    sourceVoucherDate: "...",
                    data: {},
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ACK (duplicate=true when batchId/requestId was seen before)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BatchResponse" },
                examples: {
                  fresh: { value: { acked: true, batchId: "sync_123_batch_00037", duplicate: false, receivedCount: 500 } },
                  duplicate: { value: { acked: true, batchId: "sync_123_batch_00037", duplicate: true, receivedCount: 0 } },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
          "404": { $ref: "#/components/responses/Error404" },
          "429": { $ref: "#/components/responses/Error429" },
          "500": { $ref: "#/components/responses/Error500" },
        },
      },
    },
    "/api/integrations/tally/heartbeat": {
      post: {
        summary: "Connector liveness (204 No Content)",
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/XRequestId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/HeartbeatRequest" },
              example: {
                connectorId: "wz-connector-001",
                deviceId: "string-uuid",
                appVersion: "1.0.0",
                protocolVersion: "1.0",
                tallyVersion: "TallyPrime 4.0",
                company: "Demo Company",
                lastSync: "2026-10-05T12:00:00Z",
                currentSync: null,
                status: "idle",
              },
            },
          },
        },
        responses: {
          "204": { description: "No Content" },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
          "429": { $ref: "#/components/responses/Error429" },
          "500": { $ref: "#/components/responses/Error500" },
        },
      },
    },
    "/api/integrations/tally/updates": {
      post: {
        summary: "Check for connector updates",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdatesRequest" },
              example: { appVersion: "1.0.0", protocolVersion: "1.0" },
            },
          },
        },
        responses: {
          "200": {
            description: "Update status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdatesResponse" },
                example: { updateAvailable: false, latestVersion: null, downloadUrl: null, notes: null },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "500": { $ref: "#/components/responses/Error500" },
        },
      },
    },
    "/api/integrations/tally/admin/pairing-codes": {
      post: {
        summary: "Admin: create a WZK-XXXX-XXXX pairing code linked to tenant + company",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tenantId: { type: "string" },
                  tenantName: { type: "string" },
                  companyName: { type: "string" },
                  tallyGuid: { type: "string" },
                  ttlMinutes: { type: "integer", default: 60 },
                },
              },
              example: { tenantId: "tenant-1", companyName: "Demo Company", tallyGuid: "optional-guid" },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pairingCode", "tenantId", "expiresAt"],
                  properties: {
                    pairingCode: { type: "string", pattern: "^WZK-[A-Z0-9]{4}-[A-Z0-9]{4}$" },
                    tenantId: { type: "string" },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
          "500": { $ref: "#/components/responses/Error500" },
        },
      },
    },
    "/api/integrations/tally/info": {
      get: {
        summary: "Public discovery: canonical API base URL + endpoint map",
        responses: {
          "200": {
            description: "API info (always points at https://excel.frillchills.com/api)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    apiBaseUrl: { type: "string", example: "https://excel.frillchills.com/api" },
                    protocolVersion: { type: "string", example: "1.0" },
                    heartbeatIntervalSeconds: { type: "integer", example: 120 },
                    endpoints: { type: "object", additionalProperties: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/integrations/tally/sync/batches": {
      get: {
        summary: "Receive: batch history for this tenant",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "companyId", in: "query", schema: { type: "string" } },
          { name: "entityType", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 25 } },
        ],
        responses: {
          "200": {
            description: "Batches",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    batches: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          batch_id: { type: "string" },
                          request_id: { type: "string" },
                          sync_id: { type: "string" },
                          connector_id: { type: "string" },
                          company_id: { type: "string" },
                          entity_type: { type: "string" },
                          received_count: { type: "integer" },
                          duplicate: { type: "integer" },
                          created_at: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Error401" },
        },
      },
    },
    "/api/integrations/tally/received": {
      get: {
        summary: "Receive: individual records the platform received",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "companyId", in: "query", schema: { type: "string" } },
          { name: "entityType", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "Records",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    records: { type: "array", items: { type: "object", additionalProperties: true } },
                    limit: { type: "integer" },
                    offset: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Error401" },
        },
      },
    },
    "/api/integrations/tally/commands": {
      post: {
        summary: "Push: queue a cloud-to-connector command (connector polls it outbound)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["connectorId", "command"],
                properties: {
                  connectorId: { type: "string" },
                  command: { type: "string", enum: ["REQUEST_SYNC", "PAUSE_SYNC", "RESUME_SYNC", "UPDATE_CONFIG", "PUSH_VOUCHERS", "PUSH_MASTERS"] },
                  payload: { type: "object", additionalProperties: true },
                },
              },
              example: { connectorId: "wz-connector-001", command: "REQUEST_SYNC", payload: { entityType: "sales_voucher" } },
            },
          },
        },
        responses: {
          "201": {
            description: "Queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    connectorId: { type: "string" },
                    command: { type: "string" },
                    payload: { type: "object", additionalProperties: true },
                    status: { type: "string" },
                    createdAt: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
        },
      },
    },
    "/api/integrations/tally/commands/pending": {
      get: {
        summary: "Connector polls queued pushes (outbound only, Bearer connector token)",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Pending commands (marked DELIVERED)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    commands: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          command: { type: "string" },
                          payload: { type: "object", additionalProperties: true },
                          createdAt: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Error401" },
        },
      },
    },
    "/api/integrations/tally/commands/ack": {
      post: {
        summary: "Connector acknowledges a pushed command",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["commandId", "status"],
                properties: {
                  commandId: { type: "string" },
                  status: { type: "string", enum: ["DONE", "CANCELLED"] },
                  result: {
                    type: "object",
                    description: "Phase 3 master result: outcome drives the per-master link status",
                    properties: {
                      outcome: { type: "string", enum: ["synced", "linked", "failed", "needs_review"] },
                      tallyName: { type: "string" },
                      tallyMasterId: { type: "string" },
                      error: { type: "string" },
                    },
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Acknowledged",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" }, status: { type: "string" } },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
        },
      },
    },
    "/api/integrations/tally/masters/push": {
      post: {
        summary: "Phase 3: queue WhizUnik masters (customers, suppliers, SKUs) for Tally",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["connectorId", "companyId", "items"],
                properties: {
                  connectorId: { type: "string" },
                  companyId: { type: "string" },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["kind", "id"],
                      properties: {
                        kind: { type: "string", enum: ["customer", "supplier", "sku"] },
                        id: { type: "string" },
                      },
                    },
                  },
                },
              },
              example: {
                connectorId: "wz-connector-001",
                companyId: "whiz-company-1",
                items: [{ kind: "customer", id: "cust-001" }, { kind: "sku", id: "sku-001" }],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Queued (one PUSH_MASTERS command per valid item; invalid items reported)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    connectorId: { type: "string" },
                    queued: { type: "array", items: { type: "object", additionalProperties: true } },
                    rejected: { type: "array", items: { type: "object", additionalProperties: true } },
                    queuedCount: { type: "integer" },
                    rejectedCount: { type: "integer" },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
          "404": { $ref: "#/components/responses/Error404" },
        },
      },
    },
    "/api/integrations/tally/masters/status": {
      get: {
        summary: "Phase 3: per-master sync state (NOT_SYNCED, QUEUED, SENDING, SYNCED, FAILED, NEEDS_REVIEW)",
        responses: {
          "200": {
            description: "Master states",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    masters: { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Error401" },
        },
      },
    },
    "/api/integrations/tally/masters/attempts": {
      get: {
        summary: "Phase 3: sync attempt evidence for one master (request/response payloads)",
        responses: {
          "200": {
            description: "Attempt evidence, newest first",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    attempts: { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error400" },
          "401": { $ref: "#/components/responses/Error401" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    parameters: {
      XRequestId: {
        name: "X-Request-Id",
        in: "header",
        required: false,
        schema: { type: "string" },
        description: "Optional tracing id, echoed back in the response",
      },
    },
    schemas: {
      ConnectRequest: {
        type: "object",
        required: ["pairingCode", "deviceId", "deviceName", "appVersion", "protocolVersion", "company"],
        properties: {
          pairingCode: { type: "string", pattern: "^WZK-[A-Z0-9]{4}-[A-Z0-9]{4}$" },
          deviceId: { type: "string" },
          deviceName: { type: "string" },
          appVersion: { type: "string" },
          protocolVersion: { type: "string" },
          company: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" }, tallyGuid: { type: "string" } },
          },
        },
      },
      ConnectResponse: {
        type: "object",
        required: ["connectorId", "accessToken", "refreshToken", "accessTokenExpiresAt", "tenant", "companyMapping"],
        properties: {
          connectorId: { type: "string" },
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
          accessTokenExpiresAt: { type: "string", format: "date-time" },
          tenant: {
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
          companyMapping: {
            type: "object",
            required: ["whizunikCompanyId"],
            properties: { tallyCompanyGuid: { type: "string", nullable: true }, whizunikCompanyId: { type: "string" } },
          },
        },
      },
      TokenRequest: {
        type: "object",
        required: ["refreshToken", "deviceId", "connectorId"],
        properties: { refreshToken: { type: "string" }, deviceId: { type: "string" }, connectorId: { type: "string" } },
      },
      BatchRequest: {
        type: "object",
        required: ["batchId", "requestId", "syncId", "deviceId", "companyId", "entityType", "batchNumber", "totalBatches", "records"],
        properties: {
          batchId: { type: "string" },
          requestId: { type: "string" },
          syncId: { type: "string" },
          deviceId: { type: "string" },
          companyId: { type: "string" },
          entityType: {
            type: "string",
            description:
              "sales_voucher, purchase_voucher, ledger, stock_item, company, group, unit, godown, voucher_type, receipt_voucher, payment_voucher, journal_voucher, contra_voucher, debit_note, credit_note, sales_order, purchase_order, delivery_note, receipt_note, stock_journal, day_book, etc.",
          },
          batchNumber: { type: "integer" },
          totalBatches: { type: "integer" },
          records: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                sourceCompanyId: { type: "string" },
                entityType: { type: "string" },
                sourceObjectId: { type: "string" },
                sourceVoucherNumber: { type: "string" },
                sourceVoucherDate: { type: "string" },
                data: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
      BatchResponse: {
        type: "object",
        required: ["acked", "batchId", "duplicate", "receivedCount"],
        properties: {
          acked: { type: "boolean" },
          batchId: { type: "string" },
          duplicate: { type: "boolean" },
          receivedCount: { type: "integer" },
        },
      },
      HeartbeatRequest: {
        type: "object",
        required: ["connectorId", "deviceId", "appVersion", "protocolVersion", "status"],
        properties: {
          connectorId: { type: "string" },
          deviceId: { type: "string" },
          appVersion: { type: "string" },
          protocolVersion: { type: "string" },
          tallyVersion: { type: "string" },
          company: { type: "string" },
          lastSync: { type: "string", nullable: true },
          currentSync: { type: "object", nullable: true, additionalProperties: true },
          status: { type: "string", enum: ["idle", "running", "paused", "error"] },
        },
      },
      UpdatesRequest: {
        type: "object",
        required: ["appVersion", "protocolVersion"],
        properties: { appVersion: { type: "string" }, protocolVersion: { type: "string" } },
      },
      UpdatesResponse: {
        type: "object",
        required: ["updateAvailable", "latestVersion", "downloadUrl", "notes"],
        properties: {
          updateAvailable: { type: "boolean" },
          latestVersion: { type: "string", nullable: true },
          downloadUrl: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                enum: ["INVALID_PAYLOAD", "AUTHENTICATION_FAILED", "INVALID_COMPANY", "TOKEN_EXPIRED", "RATE_LIMITED", "SERVER_ERROR"],
              },
              message: { type: "string" },
            },
          },
        },
      },
    },
    responses: {
      Error400: {
        description: "Invalid payload",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Error401: {
        description: "Auth failed",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Error404: {
        description: "Company not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Error429: {
        description: "Rate limited",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        headers: { "Retry-After": { schema: { type: "integer" } } },
      },
      Error500: {
        description: "Server error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
} as const;
