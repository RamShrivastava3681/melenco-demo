import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import { signupUser, freshRateLimits, type UserCtx } from "./helpers.js";
import { resetWzRateLimits } from "../src/integrations/tally/whizunik/auth.js";

let app: ReturnType<typeof createApp>;
let user: UserCtx;

const DEVICE_ID = "123e4567-e89b-12d3-a456-426614174001";

beforeAll(async () => {
  await initTestDb();
  app = createApp();
  user = await signupUser(app, "push-vouchers@example.com");
});

beforeEach(() => {
  freshRateLimits();
  resetWzRateLimits();
});

describe("Push invoices to Tally (platform → connector)", () => {
  it("queues selected invoices as PUSH_VOUCHERS; connector polls and acks; UI can track status", async () => {
    // 1. Pair + connect a new-spec connector
    const pc = await request(app)
      .post("/api/integrations/tally/admin/pairing-codes")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ tenantName: "Push Tenant", companyName: "Push Co" });
    expect(pc.status).toBe(201);

    const connect = await request(app).post("/api/integrations/tally/connect").send({
      pairingCode: pc.body.pairingCode,
      deviceId: DEVICE_ID,
      deviceName: "DESKTOP-PUSH",
      appVersion: "1.0.0",
      protocolVersion: "1.0",
      company: { name: "Push Co", tallyGuid: "push-guid-1" },
    });
    expect(connect.status).toBe(200);
    const connectorId = connect.body.connectorId as string;
    const companyId = connect.body.companyMapping.whizunikCompanyId as string;
    const accessToken = connect.body.accessToken as string;

    // 2. Create a customer + invoice on the platform
    const cust = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ name: "Acme Traders" });
    expect(cust.status).toBe(201);

    const inv = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        invoices: [
          {
            customer_id: cust.body.customer.id,
            invoice_number: "INV-PUSH-001",
            issue_date: "2026-09-01",
            due_date: "2026-10-01",
            amount: 11800,
          },
        ],
      });
    expect(inv.status).toBe(201);
    const invoiceId = inv.body.imported[0].id as string;

    // 3. Push: platform queues PUSH_VOUCHERS
    const push = await request(app)
      .post("/api/integrations/tally/invoices/push")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId, companyId, invoiceIds: [invoiceId] });
    expect(push.status).toBe(201);
    expect(push.body.command).toBe("PUSH_VOUCHERS");
    expect(push.body.voucherCount).toBe(1);
    expect(push.body.vouchers[0].invoiceNumber).toBe("INV-PUSH-001");
    expect(push.body.vouchers[0].partyName).toBe("Acme Traders");
    const commandId = push.body.id as string;

    // 4. Connector polls pending (Bearer) and receives the push
    const pending = await request(app)
      .get("/api/integrations/tally/commands/pending")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(pending.status).toBe(200);
    const found = (pending.body.commands as Array<{ id: string; command: string }>).find(
      (c) => c.id === commandId
    );
    expect(found?.command).toBe("PUSH_VOUCHERS");

    // 5. UI list shows DELIVERED after poll
    const list = await request(app)
      .get("/api/integrations/tally/commands")
      .set("Authorization", `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const listed = (list.body.commands as Array<{ id: string; status: string }>).find(
      (c) => c.id === commandId
    );
    expect(listed?.status).toBe("DELIVERED");

    // 6. Connector acks DONE after writing to Tally
    const ack = await request(app)
      .post("/api/integrations/tally/commands/ack")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ commandId, status: "DONE" });
    expect(ack.status).toBe(200);

    // 7. UI single-status shows DONE
    const one = await request(app)
      .get(`/api/integrations/tally/commands/status/${commandId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(one.status).toBe(200);
    expect(one.body.status).toBe("DONE");

    // 8. Unknown invoice ids are rejected, not silently queued
    const bad = await request(app)
      .post("/api/integrations/tally/invoices/push")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId, companyId, invoiceIds: ["nope-not-real"] });
    expect(bad.status).toBe(400);
  });
});
