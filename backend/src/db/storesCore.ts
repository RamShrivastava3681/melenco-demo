/** Core entity stores: users, customers, suppliers, products, invoices, payments, allocations, xero. */
import { v4 as uuidv4 } from "uuid";
import {
  dbPut,
  dbGet,
  dbDelete,
  dbUpdate,
  dbQueryPk,
  dbScan,
  dbFindOneCI,
  type DbItem,
} from "./dynamo.js";
import { nowIso, userPk, userSk, customerSk, supplierSk, productSk, invoiceSk, paymentSk, allocSk, XERO_SK } from "./keys.js";

export interface UserItem extends DbItem {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  created_at: string;
}

// --- Users ---
export async function createUser(email: string, passwordHash: string, name: string): Promise<UserItem> {
  const id = uuidv4();
  const item: UserItem = {
    pk: userPk(id),
    sk: userSk(id),
    recordType: "USER",
    id,
    user_id: id,
    email,
    password_hash: passwordHash,
    name,
    created_at: nowIso(),
  };
  await dbPut(item);
  return item;
}

export async function seedUser(id: string, email: string, passwordHash: string, name: string): Promise<UserItem> {
  const existing = await dbGet<UserItem>(userPk(id), userSk(id));
  if (existing) return existing;
  const item: UserItem = {
    pk: userPk(id),
    sk: userSk(id),
    recordType: "USER",
    id,
    user_id: id,
    email,
    password_hash: passwordHash,
    name,
    created_at: nowIso(),
  };
  await dbPut(item);
  return item;
}

export async function getUserById(id: string): Promise<UserItem | undefined> {
  return dbGet<UserItem>(userPk(id), userSk(id));
}

export async function getUserByEmail(email: string): Promise<UserItem | undefined> {
  const found = await dbScan(
    (it) => it.recordType === "USER" && it.email === email,
    2
  );
  return found[0] as UserItem | undefined;
}

// --- Normalization helpers (single source of truth for dedupe) ---
/** Trim + case-fold a display name so " Acme " and "ACME" are the same customer. */
export function normName(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}
/** Trim an invoice/voucher number; compare case-insensitively to avoid dups. */
export function normInvoiceNumber(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}
async function listByUserAndPrefix(userId: string, prefix: string): Promise<DbItem[]> {
  return dbQueryPk(userPk(userId), prefix);
}

export async function getUserScopedItem(userId: string, sk: string): Promise<DbItem | undefined> {
  return dbGet<DbItem>(userPk(userId), sk);
}

export async function deleteUserScopedItem(userId: string, sk: string): Promise<void> {
  await dbDelete(userPk(userId), sk);
}

// --- Customers ---
export async function listCustomers(userId: string): Promise<DbItem[]> {
  const rows = await listByUserAndPrefix(userId, "CUSTOMER#");
  rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return rows;
}

export async function getCustomer(userId: string, id: string): Promise<DbItem | undefined> {
  return getUserScopedItem(userId, customerSk(id));
}

export async function findCustomerByName(userId: string, name: string): Promise<DbItem | undefined> {
  const rows = await listByUserAndPrefix(userId, "CUSTOMER#");
  const want = normName(name);
  if (!want) return undefined;
  return rows.find((r) => normName(r.name) === want);
}

export async function findCustomerByNameCI(userId: string, name: string): Promise<DbItem | undefined> {
  return findCustomerByName(userId, name);
}

export async function createCustomer(userId: string, name: string, extra?: Record<string, any>): Promise<DbItem> {
  const clean = String(name ?? "").trim();
  if (!clean) {
    throw new Error("Name is required");
  }
  const clash = await findCustomerByName(userId, clean);
  if (clash) {
    const err: any = new Error("UNIQUE constraint failed: customers.user_id, name");
    throw err;
  }
  const id = uuidv4();
  const item: DbItem = {
    pk: userPk(userId),
    sk: customerSk(id),
    recordType: "CUSTOMER",
    id,
    user_id: userId,
    name: clean,
    created_at: nowIso(),
    version: 1,
    ...(extra || {}),
  };
  await dbPut(item);
  return item;
}

export async function deleteCustomer(userId: string, id: string): Promise<void> {
  await deleteUserScopedItem(userId, customerSk(id));
}

// --- Suppliers ---
export async function listSuppliers(userId: string): Promise<DbItem[]> {
  const rows = await listByUserAndPrefix(userId, "SUPPLIER#");
  rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return rows;
}

export async function getSupplier(userId: string, id: string): Promise<DbItem | undefined> {
  return getUserScopedItem(userId, supplierSk(id));
}

export async function findSupplierByName(userId: string, name: string): Promise<DbItem | undefined> {
  const rows = await listByUserAndPrefix(userId, "SUPPLIER#");
  const want = normName(name);
  if (!want) return undefined;
  return rows.find((r) => normName(r.name) === want);
}

export async function createSupplier(userId: string, name: string, extra?: Record<string, any>): Promise<DbItem> {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("Name is required");
  const clash = await findSupplierByName(userId, clean);
  if (clash) {
    const err: any = new Error("UNIQUE constraint failed: suppliers.user_id, name");
    throw err;
  }
  const id = uuidv4();
  const item: DbItem = {
    pk: userPk(userId),
    sk: supplierSk(id),
    recordType: "SUPPLIER",
    id,
    user_id: userId,
    name: clean,
    created_at: nowIso(),
    version: 1,
    ...(extra || {}),
  };
  await dbPut(item);
  return item;
}

// --- Products ---
export async function listProducts(userId: string, limit = 500): Promise<DbItem[]> {
  const rows = await listByUserAndPrefix(userId, "PRODUCT#");
  rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return rows.slice(0, limit);
}

export async function getProduct(userId: string, id: string): Promise<DbItem | undefined> {
  return getUserScopedItem(userId, productSk(id));
}

export async function findProductByName(userId: string, name: string): Promise<DbItem | undefined> {
  const rows = await listByUserAndPrefix(userId, "PRODUCT#");
  const want = normName(name);
  if (!want) return undefined;
  return rows.find((r) => normName(r.name) === want);
}

export async function createProduct(userId: string, data: Record<string, any>): Promise<DbItem> {
  const id = uuidv4();
  const item: DbItem = {
    pk: userPk(userId),
    sk: productSk(id),
    recordType: "PRODUCT",
    id,
    user_id: userId,
    created_at: nowIso(),
    version: 1,
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function updateProduct(userId: string, id: string, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(userPk(userId), productSk(id), attrs);
}

// --- Invoices ---
export async function listInvoices(
  userId: string,
  filters?: { customer_id?: string; status?: string; due_date_lte?: string }
): Promise<DbItem[]> {
  let rows = await listByUserAndPrefix(userId, "INVOICE#");
  // Safety dedupe: same customer + same normalized invoice number kept once
  // (oldest/first record wins, keeps the view exact even if legacy dups exist).
  const seen = new Set<string>();
  const deduped: DbItem[] = [];
  for (const r of rows) {
    const key = `${String(r.customer_id ?? "")}|${normInvoiceNumber(r.invoice_number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  rows = deduped;
  if (filters?.customer_id) rows = rows.filter((r) => r.customer_id === filters.customer_id);
  if (filters?.status) rows = rows.filter((r) => r.status === filters.status);
  if (filters?.due_date_lte) rows = rows.filter((r) => String(r.due_date || "") <= String(filters.due_date_lte));
  // Stable, view-friendly order: due date, then invoice number, then issue date.
  rows.sort((a, b) => {
    const d = String(a.due_date || "").localeCompare(String(b.due_date || ""));
    if (d !== 0) return d;
    const n = normInvoiceNumber(a.invoice_number).localeCompare(normInvoiceNumber(b.invoice_number));
    if (n !== 0) return n;
    return String(a.issue_date || "").localeCompare(String(b.issue_date || ""));
  });
  return rows;
}

export async function getInvoice(userId: string, id: string): Promise<DbItem | undefined> {
  return getUserScopedItem(userId, invoiceSk(id));
}

export async function getInvoiceByIdGlobal(id: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "INVOICE" && it.id === id, 2);
  return found[0];
}

export async function findInvoiceByNumber(
  userId: string,
  customerId: string,
  invoiceNumber: string
): Promise<DbItem | undefined> {
  const rows = await listByUserAndPrefix(userId, "INVOICE#");
  const want = normInvoiceNumber(invoiceNumber);
  if (!want) return undefined;
  return rows.find((r) => r.customer_id === customerId && normInvoiceNumber(r.invoice_number) === want);
}

export async function createInvoice(userId: string, data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const cleanNumber = String(data.invoice_number ?? "").trim();
  const item: DbItem = {
    pk: userPk(userId),
    sk: invoiceSk(id),
    recordType: "INVOICE",
    id,
    user_id: userId,
    created_at: nowIso(),
    ...data,
    invoice_number: cleanNumber || data.invoice_number,
  };
  await dbPut(item);
  return item;
}

export async function updateInvoice(userId: string, id: string, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(userPk(userId), invoiceSk(id), attrs);
}

export async function deleteInvoice(userId: string, id: string): Promise<void> {
  await deleteUserScopedItem(userId, invoiceSk(id));
}

// --- Payments ---
export async function listPayments(userId: string): Promise<DbItem[]> {
  const rows = await listByUserAndPrefix(userId, "PAYMENT#");
  // Dedupe identical rows by id (defensive: keeps newest-first order exact).
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const id = String(r.id ?? r.sk ?? "");
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  unique.sort((a, b) => {
    const d = String(b.payment_date || "").localeCompare(String(a.payment_date || ""));
    if (d !== 0) return d;
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
  return unique;
}

export async function getPayment(userId: string, id: string): Promise<DbItem | undefined> {
  return getUserScopedItem(userId, paymentSk(id));
}

export async function listPaymentsWithRemaining(userId: string, customerId: string): Promise<DbItem[]> {
  const rows = await listByUserAndPrefix(userId, "PAYMENT#");
  return rows.filter((r) => r.customer_id === customerId && Number(r.remaining) > 0);
}

export async function zeroRemainingPayments(userId: string, customerId: string): Promise<void> {
  const rows = await listPaymentsWithRemaining(userId, customerId);
  for (const r of rows) {
    await dbUpdate(userPk(userId), r.sk, { remaining: 0 });
  }
}

export async function createPayment(userId: string, data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(userId),
    sk: paymentSk(id),
    recordType: "PAYMENT",
    id,
    user_id: userId,
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function updatePayment(userId: string, id: string, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(userPk(userId), paymentSk(id), attrs);
}

// --- Payment allocations ---
export async function listAllocations(userId: string): Promise<DbItem[]> {
  const rows = await listByUserAndPrefix(userId, "ALLOC#");
  rows.sort((a, b) => String(a.applied_date || "").localeCompare(String(b.applied_date || "")));
  return rows;
}

export async function listAllocationsForInvoice(userId: string, invoiceId: string): Promise<DbItem[]> {
  const rows = await listByUserAndPrefix(userId, "ALLOC#");
  return rows.filter((r) => r.invoice_id === invoiceId);
}

export async function findAllocationMatch(
  userId: string,
  _customerId: string,
  invoiceId: string,
  _paymentDate: string,
  amountApplied: number
): Promise<DbItem | undefined> {
  const allocs = await listByUserAndPrefix(userId, "ALLOC#");
  return allocs.find(
    (a) => a.invoice_id === invoiceId && Number(a.amount_applied) === Number(amountApplied)
  );
}

/** Xero duplicate-payment check: allocation + parent payment match on date/amount. */
export async function findPaymentAllocationExact(
  userId: string,
  customerId: string,
  invoiceId: string,
  paymentDate: string,
  amountApplied: number
): Promise<DbItem | undefined> {
  const [allocs, payments] = await Promise.all([
    listByUserAndPrefix(userId, "ALLOC#"),
    listByUserAndPrefix(userId, "PAYMENT#"),
  ]);
  const payById = new Map(payments.map((p) => [p.id, p]));
  return allocs.find((a) => {
    if (a.invoice_id !== invoiceId || Number(a.amount_applied) !== Number(amountApplied)) return false;
    const p = payById.get(a.payment_id);
    if (!p) return false;
    return p.customer_id === customerId && p.payment_date === paymentDate;
  });
}

export async function createAllocation(userId: string, data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(userId),
    sk: allocSk(id),
    recordType: "ALLOC",
    id,
    user_id: userId,
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

// --- Xero connections (one per user) ---
export async function getXeroConnection(userId: string): Promise<DbItem | undefined> {
  return dbGet<DbItem>(userPk(userId), XERO_SK);
}

export async function getXeroByState(state: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "XERO" && it.session_state === state, 2);
  return found[0];
}

export async function listXeroWithState(): Promise<DbItem[]> {
  return dbScan((it) => it.recordType === "XERO" && it.session_state !== null && it.session_state !== undefined);
}

export async function upsertXeroConnection(userId: string, attrs: Record<string, any>): Promise<DbItem> {
  const existing = await getXeroConnection(userId);
  if (existing) {
    const next = (await dbUpdate<DbItem>(userPk(userId), XERO_SK, {
      ...attrs,
      updated_at: nowIso(),
    })) as DbItem;
    return next;
  }
  const item: DbItem = {
    pk: userPk(userId),
    sk: XERO_SK,
    recordType: "XERO",
    id: attrs.id || uuidv4(),
    user_id: userId,
    connected_at: nowIso(),
    updated_at: nowIso(),
    ...attrs,
  };
  await dbPut(item);
  return item;
}

export async function deleteXeroConnection(userId: string): Promise<void> {
  await dbDelete(userPk(userId), XERO_SK);
}


