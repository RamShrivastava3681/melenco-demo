import { getToken } from "./auth";

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
    request<{ invoices: any[]; count: number }>("/invoices", {
      method: "POST",
      body: JSON.stringify({ invoices }),
    }),

  exportClosedInvoices: () =>
    request<{ rows: any[] }>("/invoices/export/closed"),

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
};
