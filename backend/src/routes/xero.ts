import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { XeroClient } from "xero-node";
import {
  getXeroConnection,
  getXeroByState,
  listXeroWithState,
  upsertXeroConnection,
  deleteXeroConnection,
  findCustomerByName,
  createCustomer,
  findInvoiceByNumber,
  createInvoice,
  updateInvoice,
  findPaymentAllocationExact,
  createPayment,
  createAllocation,
} from "../db/storesCore.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

function getXeroClient(state?: string): XeroClient {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID || "",
    clientSecret: process.env.XERO_CLIENT_SECRET || "",
    redirectUris: [
      process.env.XERO_REDIRECT_URI || "http://localhost:3001/api/xero/callback",
    ],
    scopes: ["openid", "profile", "email", "accounting.contacts", "accounting.invoices", "accounting.payments", "offline_access"],
    httpTimeout: 30000,
    state, // <-- CRITICAL: Pass state so buildConsentUrl() includes it in the URL
  });
}

// --- Generate Xero consent URL ---
router.get("/auth-url", requireAuth, async (req: Request, res: Response) => {
  try {
    const state = uuidv4();
    console.log("[Xero auth-url] Generated state:", state);

    // Store state in the DB FIRST, before building the consent URL
    const existing = await getXeroConnection(req.user!.userId);
    if (existing) {
      await upsertXeroConnection(req.user!.userId, { session_state: state });
    } else {
      await upsertXeroConnection(req.user!.userId, { id: uuidv4(), session_state: state });
    }

    // IMPORTANT: Pass the state to getXeroClient() so buildConsentUrl() includes it
    const xero = getXeroClient(state);
    console.log("[Xero auth-url] Redirect URI:", process.env.XERO_REDIRECT_URI || "http://localhost:3001/api/xero/callback");

    xero.buildConsentUrl().then((consentUrl: string) => {
      console.log("[Xero auth-url] Generated consent URL:", consentUrl);
      res.json({ url: consentUrl });
    }).catch((err: any) => {
      console.error("[Xero auth-url] buildConsentUrl error:", err);
      res.status(500).json({ error: "Failed to generate Xero consent URL" });
    });
  } catch (error) {
    console.error("[Xero auth-url] Error:", error);
    res.status(500).json({ error: "Failed to generate Xero auth URL" });
  }
});

// --- OAuth2 callback handler ---
router.get("/callback", async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;
    const feUrl = process.env.FRONTEND_URL || "http://localhost:5173";

    console.log("[Xero callback] Received callback request");
    console.log("[Xero callback] Full URL:", `${req.protocol}://${req.get("host")}${req.originalUrl}`);
    console.log("[Xero callback] Query params - code:", code ? "PRESENT" : "MISSING", "state:", state ? "PRESENT" : "MISSING", "error:", error || "none");

    if (error) {
      console.error("[Xero callback] Xero returned error:", error);
      res.redirect(`${feUrl}/app?xero_error=${encodeURIComponent(error as string)}`);
      return;
    }

    if (!code || !state) {
      console.error("[Xero callback] Missing code or state - code:", !!code, "state:", !!state);
      res.redirect(`${feUrl}/app?xero_error=missing_code_or_state`);
      return;
    }

    console.log("[Xero callback] Received code:", (code as string).substring(0, 20) + "...");
    console.log("[Xero callback] Received state:", state);

    // Find the connection by state
    const connection = await getXeroByState(state as string) as { id: string; user_id: string } | undefined;

    if (!connection) {
      console.error("[Xero callback] No connection found for state:", state);
      // Debug: show all stored states
      const allStates = await listXeroWithState();
      console.error("[Xero callback] Stored states in DB:", JSON.stringify(allStates.map((s) => ({ id: s.id, session_state: s.session_state, user_id: s.user_id }))));
      res.redirect(`${feUrl}/app?xero_error=invalid_state`);
      return;
    }

    console.log("[Xero callback] Found connection. ID:", connection.id, "User:", connection.user_id);

    // IMPORTANT: Pass the state to XeroClient so apiCallback() can validate it internally
    const xero = getXeroClient(state as string);
    // xero-node's apiCallback does `new URL(callbackUrl)` internally, so we need the FULL absolute URL
    const fullCallbackUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    console.log("[Xero callback] Full callback URL for apiCallback:", fullCallbackUrl);

    const tokenSet = await xero.apiCallback(fullCallbackUrl);
    console.log("[Xero callback] Token exchange successful! expires_in:", tokenSet.expires_in);
    console.log("[Xero callback] Has access_token:", !!tokenSet.access_token);
    console.log("[Xero callback] Has refresh_token:", !!tokenSet.refresh_token);

    // Update the connection with tokens
    const expiresAt = new Date(
      Date.now() + ((tokenSet.expires_in || 1800) as number) * 1000
    ).toISOString();

    await upsertXeroConnection(connection.user_id, {
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      token_expires_at: expiresAt,
      session_state: null,
    });

    // Get tenants
    await xero.updateTenants(false);
    const tenants = xero.tenants;
    console.log("[Xero callback] Tenants found:", tenants?.length || 0);

    if (tenants && tenants.length > 0) {
      const tenant = tenants[0];
      const decoded = tokenSet.decodedPayload as Record<string, any> | undefined;
      console.log("[Xero callback] Tenant ID:", tenant.tenantId, "Name:", tenant.tenantName);

      await upsertXeroConnection(connection.user_id, {
        tenant_id: tenant.tenantId || "",
        tenant_name: tenant.tenantName || "",
        xero_user_id: decoded?.xero_userid || null,
      });
    }

    console.log("[Xero callback] Success! Redirecting to frontend with xero_connected=true");
    res.redirect(`${feUrl}/app?xero_connected=true`);
  } catch (error) {
    console.error("[Xero callback] Error:", error);
    const feUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${feUrl}/app?xero_error=callback_failed`);
  }
});

// --- Get connection status ---
router.get("/status", requireAuth, async (req: Request, res: Response) => {
  try {
    const connection = await getXeroConnection(req.user!.userId) as {
      id: string;
      tenant_id: string | null;
      tenant_name: string | null;
      xero_user_id: string | null;
      token_expires_at: string | null;
      connected_at: string;
      updated_at: string;
    } | undefined;

    if (!connection || !connection.tenant_id) {
      res.json({ connected: false });
      return;
    }

    const isExpired = connection.token_expires_at
      ? new Date(connection.token_expires_at) < new Date()
      : true;

    res.json({
      connected: true,
      tenantId: connection.tenant_id,
      tenantName: connection.tenant_name,
      xeroUserId: connection.xero_user_id,
      tokenExpired: isExpired,
      connectedAt: connection.connected_at,
      updatedAt: connection.updated_at,
    });
  } catch (error) {
    console.error("Xero status error:", error);
    res.status(500).json({ error: "Failed to get Xero connection status" });
  }
});

// --- Disconnect Xero ---
router.post("/disconnect", requireAuth, async (req: Request, res: Response) => {
  try {
    const connection = await getXeroConnection(req.user!.userId) as { id: string; access_token: string } | undefined;

    if (connection) {
      // Disconnect from Xero (best effort)
      try {
        const xero = getXeroClient();
        xero.setTokenSet({ access_token: connection.access_token } as any);
        xero.disconnect(connection.id).catch(() => {});
      } catch {
        // Ignore disconnect errors
      }

      await deleteXeroConnection(req.user!.userId);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Xero disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect Xero" });
  }
});

// --- Refresh token helper ---
async function getValidToken(userId: string): Promise<{ accessToken: string; tenantId: string } | null> {
  const connection = await getXeroConnection(userId) as {
    id: string;
    access_token: string;
    refresh_token: string;
    token_expires_at: string;
    tenant_id: string;
  } | undefined;

  if (!connection || !connection.tenant_id) return null;

  const isExpired = connection.token_expires_at
    ? new Date(connection.token_expires_at) < new Date()
    : true;

  if (isExpired && connection.refresh_token) {
    try {
      const xero = getXeroClient();
      xero.setTokenSet({
        access_token: connection.access_token,
        refresh_token: connection.refresh_token,
      } as any);
      const tokenSet = await xero.refreshToken();

      const expiresAt = new Date(
        Date.now() + ((tokenSet.expires_in || 1800) as number) * 1000
      ).toISOString();

      await upsertXeroConnection(userId, {
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token,
        token_expires_at: expiresAt,
      });

      return { accessToken: tokenSet.access_token as string, tenantId: connection.tenant_id };
    } catch (err) {
      console.error("Xero token refresh error:", err);
      return null;
    }
  }

  return { accessToken: connection.access_token, tenantId: connection.tenant_id };
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

// Helper to format dates from Xero objects (could be Date, string, or null)
function formatDate(d: any): string {
  if (!d) return new Date().toISOString().split("T")[0];
  if (typeof d === "string") return d.split("T")[0];
  if (d instanceof Date) return d.toISOString().split("T")[0];
  return String(d).split("T")[0];
}

// Compute due date from issue date + net payment term days
function computeDueDate(issueDate: string, netDays: number): string {
  const d = new Date(issueDate);
  if (isNaN(d.getTime())) return issueDate;
  d.setDate(d.getDate() + netDays);
  return d.toISOString().split("T")[0];
}

// --- Preview invoices from Xero (without saving) ---
router.post("/preview", requireAuth, async (req: Request, res: Response) => {
  try {
    const { contactIds, dateFrom, dateTo, paymentTerms } = req.body;
    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: "contactIds must be a non-empty array" });
      return;
    }

    const tokens = await getValidToken(req.user!.userId);
    if (!tokens) {
      res.status(400).json({ error: "Xero not connected or session expired. Reconnect to Xero." });
      return;
    }

    const xero = getXeroClient();
    xero.setTokenSet({ access_token: tokens.accessToken } as any);
    const tenantId = tokens.tenantId;

    // --- Fetch Contacts from Xero ---
    const contactsRes = await xero.accountingApi.getContacts(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      headers: { "User-Agent": "Ledgerly" },
    });
    const allContacts: any[] = (contactsRes.body as any).contacts || [];

    // Filter to only selected contact IDs
    const selectedXeroContacts = allContacts.filter((c: any) => contactIds.includes(c.contactID));

    // Build contact name map
    const contactNameMap = new Map<string, string>();
    for (const c of selectedXeroContacts) {
      contactNameMap.set(c.contactID, c.name || "Unknown");
    }

    // --- Fetch Invoices from Xero ---
    const invoicesRes = await xero.accountingApi.getInvoices(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      headers: { "User-Agent": "Ledgerly" },
    });
    const xeroInvoices: any[] = (invoicesRes.body as any).invoices || [];

    // Filter invoices to only those belonging to selected contacts
    const selectedContactIdsSet = new Set(contactIds);

    // Parse dateFrom and dateTo for client-side filtering by invoice date (issue date)
    let dateFromMs: number | null = null;
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (!isNaN(d.getTime())) {
        dateFromMs = d.getTime();
      }
    }
    let dateToMs: number | null = null;
    if (dateTo) {
      const d = new Date(dateTo);
      if (!isNaN(d.getTime())) {
        dateToMs = d.getTime() + 86400000;
      }
    }

    const previewInvoices = xeroInvoices
      .filter((inv: any) => {
        // Must belong to selected contact
        if (!inv.contact?.contactID || !selectedContactIdsSet.has(inv.contact.contactID)) return false;

        // Filter by invoice date (issue date)
        if (inv.date) {
          const invDate = new Date(inv.date).getTime();
          if (!isNaN(invDate)) {
            if (dateFromMs !== null && invDate < dateFromMs) return false;
            if (dateToMs !== null && invDate >= dateToMs) return false;
          }
        }

        return true;
      })
      .map((inv: any) => {
        const contactId = inv.contact?.contactID || "";
        const issueDate = formatDate(inv.date);
        const netDays = paymentTerms?.[contactId] || 0;
        const dueDate = netDays > 0 ? computeDueDate(issueDate, netDays) : formatDate(inv.dueDate);
        const amount = inv.total ? Number(inv.total) : 0;
        const amountDue = inv.amountDue ? Number(inv.amountDue) : amount;
        const xeroStatus = String(inv.status || "");
        const ourStatus = (xeroStatus === "AUTHORISED" || xeroStatus === "SUBMITTED") ? "open"
          : xeroStatus === "PAID" ? "closed"
          : "open";

        return {
          contactId,
          contactName: contactNameMap.get(contactId) || "Unknown",
          invoiceNumber: inv.invoiceNumber || "",
          issueDate,
          dueDate,
          amount,
          balance: amountDue,
          status: ourStatus,
          closedDate: ourStatus === "closed" ? formatDate(inv.fullyPaidOnDate) : null,
        };
      });

    // Sort by contact name, then by issue date
    previewInvoices.sort((a: any, b: any) => {
      if (a.contactName !== b.contactName) return a.contactName.localeCompare(b.contactName);
      return a.issueDate.localeCompare(b.issueDate);
    });

    const totalAmount = previewInvoices.reduce((sum: number, inv: any) => sum + inv.amount, 0);

    res.json({
      success: true,
      invoices: previewInvoices,
      summary: {
        totalInvoices: previewInvoices.length,
        totalContacts: contactIds.length,
        totalAmount: +totalAmount.toFixed(2),
      },
    });
  } catch (error: any) {
    console.error("Xero preview error:", error);
    if (error.response?.status === 401 || error.response?.status === 403) {
      res.status(401).json({ error: "Xero session expired. Please reconnect." });
    } else {
      res.status(500).json({ error: "Failed to preview invoices from Xero: " + (error.message || "Unknown error") });
    }
  }
});

// --- Fetch contacts from Xero filtered by type (customers/suppliers) ---
router.post("/contacts", requireAuth, async (req: Request, res: Response) => {
  try {
    const { contactType } = req.body;
    if (!contactType || !["customers", "suppliers"].includes(contactType)) {
      res.status(400).json({ error: "contactType must be 'customers' or 'suppliers'" });
      return;
    }

    const tokens = await getValidToken(req.user!.userId);
    if (!tokens) {
      res.status(400).json({ error: "Xero not connected or session expired. Reconnect to Xero." });
      return;
    }

    const xero = getXeroClient();
    xero.setTokenSet({ access_token: tokens.accessToken } as any);
    const tenantId = tokens.tenantId;

    const contactsRes = await xero.accountingApi.getContacts(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      headers: { "User-Agent": "Ledgerly" },
    });
    const contacts: any[] = (contactsRes.body as any).contacts || [];

    // Filter by contact type
    const filtered = contacts.filter((c: any) => {
      if (contactType === "customers") return c.isCustomer === true;
      return c.isSupplier === true;
    }).map((c: any) => ({
      id: c.contactID,
      name: c.name || "Unknown",
      email: c.emailAddress || "",
      isCustomer: !!c.isCustomer,
      isSupplier: !!c.isSupplier,
    }));

    // Sort alphabetically
    filtered.sort((a: any, b: any) => a.name.localeCompare(b.name));

    res.json({ contacts: filtered });
  } catch (error: any) {
    console.error("Xero fetch contacts error:", error);
    if (error.response?.status === 401 || error.response?.status === 403) {
      res.status(401).json({ error: "Xero session expired. Please reconnect." });
    } else {
      res.status(500).json({ error: "Failed to fetch contacts from Xero: " + (error.message || "Unknown error") });
    }
  }
});

// --- Import selected contacts and their invoices from Xero ---
router.post("/import", requireAuth, async (req: Request, res: Response) => {
  try {
    const { contactIds, dateFrom, dateTo, paymentTerms } = req.body;
    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: "contactIds must be a non-empty array" });
      return;
    }

    const tokens = await getValidToken(req.user!.userId);
    if (!tokens) {
      res.status(400).json({ error: "Xero not connected or session expired. Reconnect to Xero." });
      return;
    }

    const xero = getXeroClient();
    xero.setTokenSet({ access_token: tokens.accessToken } as any);
    const tenantId = tokens.tenantId;

    // --- Fetch Contacts from Xero ---
    const contactsRes = await xero.accountingApi.getContacts(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      headers: { "User-Agent": "Ledgerly" },
    });
    const allContacts: any[] = (contactsRes.body as any).contacts || [];

    // Filter to only selected contact IDs
    const selectedXeroContacts = allContacts.filter((c: any) => contactIds.includes(c.contactID));

    // Map Xero contact IDs to our internal customer IDs
    const contactIdMap = new Map<string, string>(); // Xero contactID -> our customer ID
    let contactsCreated = 0;

    for (const contact of selectedXeroContacts) {
      const name = contact.name || "Unknown";
      const existing = await findCustomerByName(req.user!.userId, name);

      if (existing) {
        contactIdMap.set(contact.contactID, existing.id as string);
      } else {
        const created = await createCustomer(req.user!.userId, name);
        contactIdMap.set(contact.contactID, created.id as string);
        contactsCreated++;
      }
    }

    // --- Fetch Invoices from Xero ---
    const invoicesOptions: any = {
      headers: { "User-Agent": "Ledgerly" },
    };

    const invoicesRes = await xero.accountingApi.getInvoices(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      headers: { "User-Agent": "Ledgerly" },
    });
    const xeroInvoices: any[] = (invoicesRes.body as any).invoices || [];

    // Filter invoices to only those belonging to selected contacts
    const selectedContactIdsSet = new Set(contactIds);

    // Parse dateFrom and dateTo for client-side filtering by invoice date (issue date)
    let dateFromMs: number | null = null;
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (!isNaN(d.getTime())) {
        dateFromMs = d.getTime();
      }
    }
    let dateToMs: number | null = null;
    if (dateTo) {
      const d = new Date(dateTo);
      if (!isNaN(d.getTime())) {
        // Set to end of day so invoices on the 'to' date are included
        dateToMs = d.getTime() + 86400000;
      }
    }

    const relevantInvoices = xeroInvoices.filter((inv: any) => {
      // Must belong to selected contact
      if (!inv.contact?.contactID || !selectedContactIdsSet.has(inv.contact.contactID)) return false;

      // Filter by invoice date (issue date)
      if (inv.date) {
        const invDate = new Date(inv.date).getTime();
        if (!isNaN(invDate)) {
          // If dateFrom is set, only include invoices on or after that date
          if (dateFromMs !== null && invDate < dateFromMs) return false;
          // If dateTo is set, only include invoices on or before that date
          if (dateToMs !== null && invDate >= dateToMs) return false;
        }
      }

      return true;
    });

    let invoicesCreated = 0;
    let invoicesUpdated = 0;

    for (const xeroInv of relevantInvoices) {
      if (!xeroInv.invoiceNumber || !xeroInv.contact?.contactID) continue;

      // Map Xero status to our status
      const xeroStatus = String(xeroInv.status || "");
      const ourStatus = (xeroStatus === "AUTHORISED" || xeroStatus === "SUBMITTED") ? "open"
        : xeroStatus === "PAID" ? "closed"
        : "open";

      // Find our customer ID from the map
      const customerId = contactIdMap.get(xeroInv.contact.contactID);
      if (!customerId) continue;

      const invoiceNumber = xeroInv.invoiceNumber;
      const issueDate = formatDate(xeroInv.date);
      const netDays = paymentTerms?.[xeroInv.contact.contactID] || 0;
      const dueDate = netDays > 0 ? computeDueDate(issueDate, netDays) : formatDate(xeroInv.dueDate);
      const amount = xeroInv.total ? Number(xeroInv.total) : 0;
      const amountDue = xeroInv.amountDue ? Number(xeroInv.amountDue) : amount;
      const closedDate = ourStatus === "closed" ? formatDate(xeroInv.fullyPaidOnDate) : null;

      // Compute payment_days & late_payment_days for closed invoices
      let payDays: number | null = null;
      let lateDays: number | null = null;
      if (ourStatus === "closed" && closedDate) {
        payDays = daysBetween(issueDate, closedDate);
        lateDays = Math.max(0, daysBetween(dueDate, closedDate));
      }

      // Check if invoice exists
      const existing = await findInvoiceByNumber(req.user!.userId, customerId, invoiceNumber);

      if (existing) {
        await updateInvoice(req.user!.userId, existing.id as string, {
          issue_date: issueDate,
          due_date: dueDate,
          amount,
          balance: amountDue,
          status: ourStatus,
          closed_date: closedDate,
          payment_days: payDays,
          late_payment_days: lateDays,
        });
        invoicesUpdated++;
      } else {
        await createInvoice(req.user!.userId, {
          customer_id: customerId,
          invoice_number: invoiceNumber,
          issue_date: issueDate,
          due_date: dueDate,
          amount,
          balance: amountDue,
          status: ourStatus,
          closed_date: closedDate,
          payment_days: payDays,
          late_payment_days: lateDays,
        });
        invoicesCreated++;
      }
    }

    // --- Fetch Payments for imported invoices ---
    const paymentsRes = await xero.accountingApi.getPayments(tenantId, undefined, undefined, undefined, undefined, undefined, {
      headers: { "User-Agent": "Ledgerly" },
    });
    const xeroPayments: any[] = (paymentsRes.body as any).payments || [];

    let paymentsCreated = 0;

    // Get all imported invoice numbers
    const importedInvoiceNumbers = new Set(relevantInvoices.map((inv: any) => inv.invoiceNumber));

    for (const xeroPay of xeroPayments) {
      if (!xeroPay.invoice?.invoiceNumber || !xeroPay.contact?.contactID) continue;

      // Only process payments for selected contacts' invoices that were imported
      if (!selectedContactIdsSet.has(xeroPay.contact.contactID)) continue;
      if (!importedInvoiceNumbers.has(xeroPay.invoice.invoiceNumber)) continue;

      const customerId = contactIdMap.get(xeroPay.contact.contactID);
      if (!customerId) continue;

      // Find invoice
      const invoice = await findInvoiceByNumber(req.user!.userId, customerId, xeroPay.invoice.invoiceNumber) as { id: string; amount: number; balance: number } | undefined;

      if (!invoice) continue;

      const paymentDate = formatDate(xeroPay.date);
      const amount = Number(xeroPay.amount);

      // Check if this payment already exists
      const existingPay = await findPaymentAllocationExact(
        req.user!.userId, customerId, invoice.id as string, paymentDate, amount
      );

      if (!existingPay) {
        const payAmount = Math.min(amount, Number(invoice.balance));
        if (payAmount === 0) continue;

        const paymentId = uuidv4();
        const allocationId = uuidv4();

        await createPayment(req.user!.userId, {
          id: paymentId,
          customer_id: customerId,
          payment_date: paymentDate,
          amount: payAmount,
          applied_amount: payAmount,
          remaining: 0,
          note: "Xero sync",
        });

        await createAllocation(req.user!.userId, {
          id: allocationId,
          payment_id: paymentId,
          invoice_id: invoice.id,
          amount_applied: payAmount,
          applied_date: paymentDate,
          closed_invoice: payAmount >= Number(invoice.balance) ? 1 : 0,
        });

        paymentsCreated++;
      }
    }

    res.json({
      success: true,
      contacts: { created: contactsCreated, updated: 0 },
      invoices: { created: invoicesCreated, updated: invoicesUpdated },
      payments: { created: paymentsCreated },
    });
  } catch (error: any) {
    console.error("Xero import error:", error);
    if (error.response?.status === 401 || error.response?.status === 403) {
      res.status(401).json({ error: "Xero session expired. Please reconnect." });
    } else {
      res.status(500).json({ error: "Failed to import from Xero: " + (error.message || "Unknown error") });
    }
  }
});

// --- Legacy full sync (keep for backward compatibility) ---
router.post("/sync", requireAuth, async (req: Request, res: Response) => {
  try {
    const tokens = await getValidToken(req.user!.userId);
    if (!tokens) {
      res.status(400).json({ error: "Xero not connected or session expired. Reconnect to Xero." });
      return;
    }

    const xero = getXeroClient();
    xero.setTokenSet({ access_token: tokens.accessToken } as any);
    const tenantId = tokens.tenantId;

    try {
      // --- Fetch Contacts ---
      const contactsRes = await xero.accountingApi.getContacts(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        headers: { "User-Agent": "Ledgerly" },
      });
      const contacts: any[] = (contactsRes.body as any).contacts || [];

      let contactsCreated = 0;
      let contactsUpdated = 0;

      for (const contact of contacts) {
        const name = contact.name || "Unknown";
        const existing = await findCustomerByName(req.user!.userId, name);

        if (existing) {
          contactsUpdated++;
        } else {
          await createCustomer(req.user!.userId, name);
          contactsCreated++;
        }
      }

      // --- Fetch Invoices ---
      const invoicesRes = await xero.accountingApi.getInvoices(tenantId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        headers: { "User-Agent": "Ledgerly" },
      });
      const xeroInvoices: any[] = (invoicesRes.body as any).invoices || [];

      let invoicesCreated = 0;
      let invoicesUpdated = 0;

      for (const xeroInv of xeroInvoices) {
        if (!xeroInv.invoiceNumber || !xeroInv.contact?.name) continue;

        // Map Xero status to our status
        const xeroStatus = String(xeroInv.status || "");
        const ourStatus = (xeroStatus === "AUTHORISED" || xeroStatus === "SUBMITTED") ? "open"
          : xeroStatus === "PAID" ? "closed"
          : "open";

        // Find customer by name
        const customer = await findCustomerByName(req.user!.userId, xeroInv.contact.name);

        if (!customer) continue;

        const invoiceNumber = xeroInv.invoiceNumber;
        const issueDate = formatDate(xeroInv.date);
        const dueDate = formatDate(xeroInv.dueDate);
        const amount = xeroInv.total ? Number(xeroInv.total) : 0;
        const amountDue = xeroInv.amountDue ? Number(xeroInv.amountDue) : amount;
        const closedDate = ourStatus === "closed" ? formatDate(xeroInv.fullyPaidOnDate) : null;

        // Compute payment_days & late_payment_days for closed invoices
        let payDays: number | null = null;
        let lateDays: number | null = null;
        if (ourStatus === "closed" && closedDate) {
          payDays = daysBetween(issueDate, closedDate);
          lateDays = Math.max(0, daysBetween(dueDate, closedDate));
        }

        // Check if invoice exists
        const existing = await findInvoiceByNumber(req.user!.userId, customer.id as string, invoiceNumber);

        if (existing) {
          await updateInvoice(req.user!.userId, existing.id as string, {
            issue_date: issueDate,
            due_date: dueDate,
            amount,
            balance: amountDue,
            status: ourStatus,
            closed_date: closedDate,
            payment_days: payDays,
            late_payment_days: lateDays,
          });
          invoicesUpdated++;
        } else {
          await createInvoice(req.user!.userId, {
            customer_id: customer.id,
            invoice_number: invoiceNumber,
            issue_date: issueDate,
            due_date: dueDate,
            amount,
            balance: amountDue,
            status: ourStatus,
            closed_date: closedDate,
            payment_days: payDays,
            late_payment_days: lateDays,
          });
          invoicesCreated++;
        }
      }

      // --- Fetch Payments ---
      const paymentsRes = await xero.accountingApi.getPayments(tenantId, undefined, undefined, undefined, undefined, undefined, {
        headers: { "User-Agent": "Ledgerly" },
      });
      const xeroPayments: any[] = (paymentsRes.body as any).payments || [];

      let paymentsCreated = 0;

      for (const xeroPay of xeroPayments) {
        if (!xeroPay.invoice?.invoiceNumber || !xeroPay.contact?.name) continue;

        // Find customer
        const customer = await findCustomerByName(req.user!.userId, xeroPay.contact.name);

        if (!customer) continue;

        // Find invoice
        const invoice = await findInvoiceByNumber(req.user!.userId, customer.id as string, xeroPay.invoice.invoiceNumber) as { id: string; amount: number; balance: number } | undefined;

        if (!invoice) continue;

        const paymentDate = formatDate(xeroPay.date);
        const amount = Number(xeroPay.amount);

        // Check if this payment already exists
        const existingPay = await findPaymentAllocationExact(
          req.user!.userId, customer.id as string, invoice.id as string, paymentDate, amount
        );

        if (!existingPay) {
          const payAmount = Math.min(amount, Number(invoice.balance));
          if (payAmount === 0) continue;

          const paymentId = uuidv4();
          const allocationId = uuidv4();

          await createPayment(req.user!.userId, {
            id: paymentId,
            customer_id: customer.id,
            payment_date: paymentDate,
            amount: payAmount,
            applied_amount: payAmount,
            remaining: 0,
            note: "Xero sync",
          });

          await createAllocation(req.user!.userId, {
            id: allocationId,
            payment_id: paymentId,
            invoice_id: invoice.id,
            amount_applied: payAmount,
            applied_date: paymentDate,
            closed_invoice: payAmount >= Number(invoice.balance) ? 1 : 0,
          });

          paymentsCreated++;
        }
      }

      res.json({
        success: true,
        contacts: { created: contactsCreated, updated: contactsUpdated },
        invoices: { created: invoicesCreated, updated: invoicesUpdated },
        payments: { created: paymentsCreated },
      });
    } catch (err) {
      throw err;
    }
  } catch (error: any) {
    console.error("Xero sync error:", error);
    if (error.response?.status === 401 || error.response?.status === 403) {
      res.status(401).json({ error: "Xero session expired. Please reconnect." });
    } else {
      res.status(500).json({ error: "Failed to sync data from Xero: " + (error.message || "Unknown error") });
    }
  }
});

export default router;
