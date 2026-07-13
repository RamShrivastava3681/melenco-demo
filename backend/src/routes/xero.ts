import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { XeroClient } from "xero-node";
import db from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

function getXeroClient(): XeroClient {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID || "",
    clientSecret: process.env.XERO_CLIENT_SECRET || "",
    redirectUris: [
      process.env.XERO_REDIRECT_URI || "http://localhost:3001/api/xero/callback",
    ],
    scopes: ["openid", "profile", "email", "accounting.transactions", "accounting.contacts", "offline_access"],
    httpTimeout: 30000,
  });
}

// --- Generate Xero consent URL ---
router.get("/auth-url", requireAuth, (req: Request, res: Response) => {
  try {
    const xero = getXeroClient();
    const state = uuidv4();

    // Store state in the session/DB for CSRF verification
    const existing = db.prepare("SELECT id FROM xero_connections WHERE user_id = ?").get(req.user!.userId);
    if (existing) {
      db.prepare("UPDATE xero_connections SET session_state = ?, updated_at = datetime('now') WHERE user_id = ?")
        .run(state, req.user!.userId);
    } else {
      const id = uuidv4();
      db.prepare("INSERT INTO xero_connections (id, user_id, session_state) VALUES (?, ?, ?)")
        .run(id, req.user!.userId, state);
    }

    xero.buildConsentUrl().then((consentUrl) => {
      res.json({ url: consentUrl });
    }).catch((err) => {
      console.error("Xero buildConsentUrl error:", err);
      res.status(500).json({ error: "Failed to generate Xero consent URL" });
    });
  } catch (error) {
    console.error("Xero auth URL error:", error);
    res.status(500).json({ error: "Failed to generate Xero auth URL" });
  }
});

// --- OAuth2 callback handler ---
router.get("/callback", async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      console.error("Xero OAuth error:", error);
      const feUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      res.redirect(`${feUrl}/app?xero_error=${encodeURIComponent(error as string)}`);
      return;
    }

    if (!code || !state) {
      const feUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      res.redirect(`${feUrl}/app?xero_error=missing_code_or_state`);
      return;
    }

    // Find the connection by state
    const connection = db.prepare(
      "SELECT id, user_id FROM xero_connections WHERE session_state = ?"
    ).get(state) as { id: string; user_id: string } | undefined;

    if (!connection) {
      const feUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      res.redirect(`${feUrl}/app?xero_error=invalid_state`);
      return;
    }

    const xero = getXeroClient();
    // xero-node's apiCallback does `new URL(callbackUrl)` internally, so we need the FULL absolute URL
    const fullCallbackUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const tokenSet = await xero.apiCallback(fullCallbackUrl);

    // Update the connection with tokens
    const expiresAt = new Date(
      Date.now() + ((tokenSet.expires_in || 1800) as number) * 1000
    ).toISOString();

    db.prepare(`
      UPDATE xero_connections SET
        access_token = ?,
        refresh_token = ?,
        token_expires_at = ?,
        session_state = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      tokenSet.access_token,
      tokenSet.refresh_token,
      expiresAt,
      connection.id
    );

    // Get tenants
    await xero.updateTenants(false);
    const tenants = xero.tenants;

    if (tenants && tenants.length > 0) {
      const tenant = tenants[0];
      const decoded = tokenSet.decodedPayload as Record<string, any> | undefined;
      db.prepare(`
        UPDATE xero_connections SET
          tenant_id = ?,
          tenant_name = ?,
          xero_user_id = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        tenant.tenantId || "",
        tenant.tenantName || "",
        decoded?.xero_userid || null,
        connection.id
      );
    }

    const feUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${feUrl}/app?xero_connected=true`);
  } catch (error) {
    console.error("Xero callback error:", error);
    const feUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${feUrl}/app?xero_error=callback_failed`);
  }
});

// --- Get connection status ---
router.get("/status", requireAuth, (req: Request, res: Response) => {
  try {
    const connection = db.prepare(`
      SELECT id, tenant_id, tenant_name, xero_user_id, token_expires_at, connected_at, updated_at
      FROM xero_connections WHERE user_id = ?
    `).get(req.user!.userId) as {
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
router.post("/disconnect", requireAuth, (req: Request, res: Response) => {
  try {
    const connection = db.prepare(
      "SELECT id, access_token FROM xero_connections WHERE user_id = ?"
    ).get(req.user!.userId) as { id: string; access_token: string } | undefined;

    if (connection) {
      // Disconnect from Xero (best effort)
      try {
        const xero = getXeroClient();
        xero.setTokenSet({ access_token: connection.access_token } as any);
        xero.disconnect(connection.id).catch(() => {});
      } catch {
        // Ignore disconnect errors
      }

      db.prepare("DELETE FROM xero_connections WHERE id = ?").run(connection.id);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Xero disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect Xero" });
  }
});

// --- Refresh token helper ---
async function getValidToken(userId: string): Promise<{ accessToken: string; tenantId: string } | null> {
  const connection = db.prepare(`
    SELECT id, access_token, refresh_token, token_expires_at, tenant_id
    FROM xero_connections WHERE user_id = ?
  `).get(userId) as {
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

      db.prepare(`
        UPDATE xero_connections SET
          access_token = ?,
          refresh_token = ?,
          token_expires_at = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(tokenSet.access_token, tokenSet.refresh_token, expiresAt, connection.id);

      return { accessToken: tokenSet.access_token as string, tenantId: connection.tenant_id };
    } catch (err) {
      console.error("Xero token refresh error:", err);
      return null;
    }
  }

  return { accessToken: connection.access_token, tenantId: connection.tenant_id };
}

// Helper to format dates from Xero objects (could be Date, string, or null)
function formatDate(d: any): string {
  if (!d) return new Date().toISOString().split("T")[0];
  if (typeof d === "string") return d.split("T")[0];
  if (d instanceof Date) return d.toISOString().split("T")[0];
  return String(d).split("T")[0];
}

// --- Fetch data from Xero ---
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
        const existing = db.prepare(
          "SELECT id FROM customers WHERE user_id = ? AND LOWER(name) = LOWER(?)"
        ).get(req.user!.userId, name) as { id: string } | undefined;

        if (existing) {
          contactsUpdated++;
        } else {
          const id = uuidv4();
          db.prepare(
            "INSERT INTO customers (id, user_id, name) VALUES (?, ?, ?)"
          ).run(id, req.user!.userId, name);
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
        const customer = db.prepare(
          "SELECT id FROM customers WHERE user_id = ? AND LOWER(name) = LOWER(?)"
        ).get(req.user!.userId, xeroInv.contact.name) as { id: string } | undefined;

        if (!customer) continue;

        const invoiceNumber = xeroInv.invoiceNumber;
        const issueDate = formatDate(xeroInv.date);
        const dueDate = formatDate(xeroInv.dueDate);
        const amount = xeroInv.total ? Math.abs(Number(xeroInv.total)) : 0;
        const amountDue = xeroInv.amountDue ? Math.abs(Number(xeroInv.amountDue)) : amount;
        const closedDate = ourStatus === "closed" ? formatDate(xeroInv.fullyPaidOnDate) : null;

        // Check if invoice exists
        const existing = db.prepare(
          "SELECT id FROM invoices WHERE user_id = ? AND customer_id = ? AND invoice_number = ?"
        ).get(req.user!.userId, customer.id, invoiceNumber) as { id: string } | undefined;

        if (existing) {
          db.prepare(`
            UPDATE invoices SET
              issue_date = ?, due_date = ?, amount = ?, balance = ?,
              status = ?, closed_date = ?
            WHERE id = ?
          `).run(issueDate, dueDate, amount, amountDue, ourStatus, closedDate, existing.id);
          invoicesUpdated++;
        } else {
          const id = uuidv4();
          db.prepare(`
            INSERT INTO invoices (id, user_id, customer_id, invoice_number, issue_date, due_date, amount, balance, status, closed_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, req.user!.userId, customer.id, invoiceNumber, issueDate, dueDate, amount, amountDue, ourStatus, closedDate);
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
        if (!xeroPay.invoice?.invoiceNumber || !xeroPay.contact?.name || !xeroPay.amount) continue;

        // Find customer
        const customer = db.prepare(
          "SELECT id FROM customers WHERE user_id = ? AND LOWER(name) = LOWER(?)"
        ).get(req.user!.userId, xeroPay.contact.name) as { id: string } | undefined;

        if (!customer) continue;

        // Find invoice
        const invoice = db.prepare(
          "SELECT id, amount, balance FROM invoices WHERE user_id = ? AND customer_id = ? AND invoice_number = ?"
        ).get(req.user!.userId, customer.id, xeroPay.invoice.invoiceNumber) as { id: string; amount: number; balance: number } | undefined;

        if (!invoice) continue;

        const paymentDate = formatDate(xeroPay.date);
        const amount = Math.abs(Number(xeroPay.amount));

        // Check if this payment already exists
        const existingPay = db.prepare(`
          SELECT p.id FROM payments p
          JOIN payment_allocations pa ON pa.payment_id = p.id
          WHERE p.user_id = ? AND p.customer_id = ? AND pa.invoice_id = ? AND p.payment_date = ? AND pa.amount_applied = ?
        `).get(req.user!.userId, customer.id, invoice.id, paymentDate, amount) as { id: string } | undefined;

        if (!existingPay) {
          const paymentId = uuidv4();
          const allocationId = uuidv4();
          const payAmount = Math.min(amount, invoice.balance);

          db.prepare(`
            INSERT INTO payments (id, user_id, customer_id, payment_date, amount, applied_amount, remaining, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(paymentId, req.user!.userId, customer.id, paymentDate, payAmount, payAmount, 0, "Xero sync");

          db.prepare(`
            INSERT INTO payment_allocations (id, user_id, payment_id, invoice_id, amount_applied, applied_date, closed_invoice)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(allocationId, req.user!.userId, paymentId, invoice.id, payAmount, paymentDate, payAmount >= invoice.balance ? 1 : 0);

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
