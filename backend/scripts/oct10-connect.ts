/** Pair + connect a fresh demo connector and print creds (dev only). */
const API = "http://127.0.0.1:3001";

async function main(): Promise<void> {
  const signinRes = await fetch(`${API}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "phase4-demo@whizunik.test", password: "Demo@12345" }),
  });
  const signin = (await signinRes.json()) as { token: string };
  const H = { Authorization: `Bearer ${signin.token}`, "Content-Type": "application/json" };

  const pcRes = await fetch(`${API}/api/integrations/tally/admin/pairing-codes`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ tenantName: "Phase4 Demo", companyName: "Whizunik" }),
  });
  const pc = (await pcRes.json()) as { pairingCode: string };

  const cRes = await fetch(`${API}/api/integrations/tally/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingCode: pc.pairingCode,
      deviceId: `demo-device-oct10-${Date.now()}`,
      deviceName: "DEMO-OCT10",
      appVersion: "1.0.0",
      protocolVersion: "1.0",
      company: { name: "Whizunik", tallyGuid: "demo-oct10" },
    }),
  });
  const c = (await cRes.json()) as {
    connectorId: string;
    accessToken: string;
    companyMapping: { whizunikCompanyId: string };
  };
  console.log(`CONNECTOR_ID=${c.connectorId}`);
  console.log(`COMPANY_ID=${c.companyMapping.whizunikCompanyId}`);
  console.log(`ACCESS_TOKEN=${c.accessToken}`);
}

main().catch((err) => {
  console.error("connect failed:", err);
  process.exit(1);
});
