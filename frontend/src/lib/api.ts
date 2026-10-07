import { getToken } from "./auth";

/** Canonical Tally Cloud API base URL (the URL, not the default). */
export const WHIZUNIK_API_URL =
  import.meta.env.VITE_WHIZUNIK_API_URL || "https://excel.frillchills.com/api";

const API_BASE = import.meta.env.VITE_URL
  ? `${import.meta.env.VITE_URL}/api`
  : "/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error || res.statusText, res.status);
  }

  return res.json();
}

export const api = {
  // Auth
  signup: (data: { email: string; password: string; name?: string }) =>
    request<{ token: string; user: { id: string; email: string; name: string } }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  signin: (data: { email: string; password: string }) =>
    request<{ token: string; user: { id: string; email: string; name: string } }>("/auth/signin", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getMe: () => request<{ user: { id: string; email: string; name: string; created_at: string } }>("/auth/me"),

  // Customers
  getCustomers: () =>
    request<{ customers: any[] }>("/customers"),

  createCustomer: (name: string) =>
    request<{ customer: any }>("/customers", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  deleteCustomer: (id: string) =>
    request<{ success: boolean }>(`/customers/${id}`, {
      method: "DELETE",
    }),

  // Invoices
  getInvoices: (params?: { customer_id?: string; status?: string; due_date_lte?: string }) => {
    const search = new URLSearchParams();
    if (params?.customer_id) search.set("customer_id", params.customer_id);
    if (params?.status) search.set("status", params.status);
    if (params?.due_date_lte) search.set("due_date_lte", params.due_date_lte);
    const qs = search.toString();
    return request<{ invoices: any[] }>(`/invoices${qs ? `?${qs}` : ""}`);
  },

  createInvoices: (invoices: any[]) =>
    request<{
      imported: any[];
      skipped: Array<{ invoice_number: string; customer_id: string; reason: string }>;
      errors: Array<{ invoice_number: string; error: string }>;
      importedCount: number;
      skippedCount: number;
      errorCount: number;
    }>("/invoices", {
      method: "POST",
      body: JSON.stringify({ invoices }),
    }),

  exportInvoices: (params?: { customer_id?: string; status?: string }) => {
    const search = new URLSearchParams();
    if (params?.customer_id) search.set("customer_id", params.customer_id);
    if (params?.status) search.set("status", params.status);
    const qs = search.toString();
    return request<{ rows: any[] }>(`/invoices/export${qs ? `?${qs}` : ""}`);
  },

  deleteInvoice: (id: string) =>
    request<{ success: boolean }>(`/invoices/${id}`, {
      method: "DELETE",
    }),

  // Payments
  getPayments: () =>
    request<{ payments: any[] }>("/payments"),

  getCustomerBalance: (customerId: string) =>
    request<{ remaining: number }>(`/payments/balance/${customerId}`),

  applyPayment: (data: {
    customer_id: string;
    payment_date: string;
    amount: number;
    note?: string;
    selected_invoice_ids: string[];
    use_balance?: boolean;
    auto_fifo?: boolean;
    close_future_invoices?: boolean;
  }) =>
    request<{ payment: any; allocations: any[] }>("/payments/apply", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  subtractRemaining: (paymentId: string, amount: number) =>
    request<{ success: boolean; remaining: number }>(`/payments/${paymentId}/subtract-remaining`, {
      method: "PATCH",
      body: JSON.stringify({ amount }),
    }),

  // Customer stats
  getCustomerPaymentStats: () =>
    request<{ stats: Record<string, { avg_pay_days: number | null; median_pay_days: number | null; max_pay_days: number | null; min_pay_days: number | null; closed_count: number }> }>("/customers/stats"),

  // Allocations
  getAllocations: () =>
    request<{ allocations: any[] }>("/allocations"),

  // Xero
  getXeroAuthUrl: () =>
    request<{ url: string }>("/xero/auth-url"),

  getXeroStatus: () =>
    request<{ connected: boolean; tenantId?: string; tenantName?: string; tokenExpired?: boolean }>("/xero/status"),

  disconnectXero: () =>
    request<{ success: boolean }>("/xero/disconnect", { method: "POST" }),

  syncXero: () =>
    request<{ success: boolean; contacts: { created: number; updated: number }; invoices: { created: number; updated: number }; payments: { created: number } }>("/xero/sync", { method: "POST" }),

  // Xero selective sync
  fetchXeroContacts: (contactType: "customers" | "suppliers") =>
    request<{ contacts: Array<{ id: string; name: string; email: string; isCustomer: boolean; isSupplier: boolean }> }>("/xero/contacts", {
      method: "POST",
      body: JSON.stringify({ contactType }),
    }),

  previewXeroImport: (data: { contactIds: string[]; dateFrom?: string; dateTo?: string; paymentTerms: Record<string, number> }) =>
    request<{ success: boolean; invoices: Array<{ contactId: string; contactName: string; invoiceNumber: string; issueDate: string; dueDate: string; amount: number; balance: number; status: string; closedDate: string | null }>; summary: { totalInvoices: number; totalContacts: number; totalAmount: number } }>("/xero/preview", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  importXeroContacts: (data: { contactIds: string[]; dateFrom?: string; dateTo?: string; paymentTerms: Record<string, number> }) =>
    request<{ success: boolean; contacts: { created: number; updated: number }; invoices: { created: number; updated: number }; payments: { created: number } }>("/xero/import", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // ── Tally integration (frontend) ─────────────────────────────
  createTallyPairingCode: () =>
    request<{ success: boolean; code: string; expiresAt: string; expiresInMinutes: number }>(
      "/integrations/tally/pairing-code",
      { method: "POST", body: JSON.stringify({}) }
    ),

  getTallyStatus: () =>
    request<{
      success: boolean;
      apiBaseUrl?: string;
      connected: boolean;
      pairingCodeTtlMinutes: number;
      connectors: Array<{
        id: string;
        connectorId: string;
        name: string;
        status: string;
        online: boolean;
        deviceName: string | null;
        appVersion: string | null;
        lastHeartbeat: string | null;
        lastSync: string | null;
        lastSuccessfulSync: string | null;
        createdAt: string;
      }>;
      companies: Array<{ id: string; tallyCompanyGuid: string; tallyCompanyName: string }>;
      currentSync: {
        syncId: string;
        entityType: string;
        syncType: string;
        status: string;
        totalRecords: number;
        processedRecords: number;
        totalBatches: number;
        processedBatches: number;
        failedRecords: number;
        duplicateRecords: number;
        startedAt: string;
      } | null;
      lastSync: {
        syncId: string;
        entityType: string;
        status: string;
        completedAt: string | null;
        successfulRecords: number;
        failedRecords: number;
        duplicateRecords: number;
      } | null;
      lastConnection: {
        connectorId: string;
        connectorName: string;
        connectedAt: string;
        deviceName: string | null;
        appVersion: string | null;
      } | null;
      pendingPairing: { active: boolean; expiresAt: string | null } | null;
    }>("/integrations/tally/status"),

  getTallySyncHistory: (params?: { connectorId?: string; status?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.connectorId) search.set("connectorId", params.connectorId);
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<{ success: boolean; sessions: any[] }>(
      `/integrations/tally/sync-history${qs ? `?${qs}` : ""}`
    );
  },

  disconnectTallyConnector: (connectorId: string) =>
    request<{ success: boolean }>("/integrations/tally/disconnect", {
      method: "POST",
      body: JSON.stringify({ connectorId }),
    }),

  // ── Phase 3: WhizUnik → Tally master sync ──
  getMasterStatus: (params?: { kind?: string; status?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.kind) search.set("kind", params.kind);
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<{
      masters: Array<{
        kind: string;
        id: string;
        name: string;
        displayName: string;
        version: number;
        status: string;
        tallyName: string | null;
        tallyMasterId: string | null;
        attempts: number;
        lastError: string | null;
        idempotencyKey: string | null;
        requestId: string | null;
        updatedAt: string | null;
      }>;
    }>(`/integrations/tally/masters/status${qs ? `?${qs}` : ""}`);
  },

  pushMasters: (data: { connectorId: string; companyId: string; items: Array<{ kind: string; id: string }> }) =>
    request<{
      connectorId: string;
      queued: Array<{ id: string; kind: string; commandId: string; idempotencyKey: string }>;
      rejected: Array<{ id: string; kind: string; reason: string }>;
      queuedCount: number;
      rejectedCount: number;
    }>("/integrations/tally/masters/push", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getMasterAttempts: (kind: string, id: string) =>
    request<{
      attempts: Array<{
        id: string;
        connector_id: string;
        tally_status: string;
        success: number;
        error_message: string | null;
        retry_count: number;
        requested_at: string;
        responded_at: string | null;
        requestPayload: unknown;
        responsePayload: unknown;
      }>;
    }>(`/integrations/tally/masters/attempts?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`),

  // ── Tally Cloud API info (points at https://excel.frillchills.com/api) ──
  getTallyInfo: () =>
    request<{
      apiBaseUrl: string;
      protocolVersion: string;
      heartbeatIntervalSeconds: number;
      endpoints: Record<string, string>;
    }>("/integrations/tally/info"),

  // ── Receive: what the platform got from connectors ──
  getTallyBatches: (params?: { companyId?: string; entityType?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.companyId) search.set("companyId", params.companyId);
    if (params?.entityType) search.set("entityType", params.entityType);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<{
      batches: Array<{
        batch_id: string;
        request_id: string;
        sync_id: string;
        connector_id: string;
        company_id: string;
        entity_type: string;
        received_count: number;
        duplicate: number;
        created_at: string;
      }>;
    }>(`/integrations/tally/sync/batches${qs ? `?${qs}` : ""}`);
  },

  getReceivedRecords: (params?: { companyId?: string; entityType?: string; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params?.companyId) search.set("companyId", params.companyId);
    if (params?.entityType) search.set("entityType", params.entityType);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.offset) search.set("offset", String(params.offset));
    const qs = search.toString();
    return request<{
      records: Array<{
        id: string;
        batch_id: string;
        company_id: string;
        entity_type: string;
        source_object_id: string | null;
        source_voucher_number: string | null;
        source_voucher_date: string | null;
        payload: unknown;
        created_at: string;
      }>;
      limit: number;
      offset: number;
    }>(`/integrations/tally/received${qs ? `?${qs}` : ""}`);
  },

  // ── Push: queue a cloud→connector command (connector polls outbound) ──
  pushTallyCommand: (data: {
    connectorId: string;
    command: "REQUEST_SYNC" | "PAUSE_SYNC" | "RESUME_SYNC" | "UPDATE_CONFIG" | "PUSH_VOUCHERS";
    payload?: Record<string, unknown>;
  }) =>
    request<{
      id: string;
      connectorId: string;
      command: string;
      payload: unknown;
      status: string;
      createdAt: string;
    }>("/integrations/tally/commands", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // ── Push invoices to Tally: select platform invoices → PUSH_VOUCHERS command ──
  pushTallyInvoices: (data: { connectorId: string; companyId: string; invoiceIds: string[] }) =>
    request<{
      id: string;
      connectorId: string;
      command: string;
      status: string;
      createdAt: string;
      voucherCount: number;
      missingInvoiceIds: string[];
      vouchers: Array<{
        invoiceId: string;
        invoiceNumber: string;
        partyName: string;
        amount: number;
        issueDate: string;
        dueDate: string;
      }>;
    }>("/integrations/tally/invoices/push", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getTallyCommands: (params?: { connectorId?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.connectorId) search.set("connectorId", params.connectorId);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<{
      commands: Array<{
        id: string;
        connectorId: string;
        command: string;
        status: string;
        createdAt: string;
        deliveredAt: string | null;
        completedAt: string | null;
        voucherCount?: number;
      }>;
    }>(`/integrations/tally/commands${qs ? `?${qs}` : ""}`);
  },

  getTallyCommandStatus: (id: string) =>
    request<{
      id: string;
      connectorId: string;
      command: string;
      payload: unknown;
      status: string;
      createdAt: string;
      deliveredAt: string | null;
      completedAt: string | null;
    }>(`/integrations/tally/commands/status/${id}`),
};
