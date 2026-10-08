import { Router, Request, Response, NextFunction } from "express";
import connectorRoutes from "./routes/connector.routes.js";
import statusRoutes from "./routes/status.routes.js";
import pushDataRoutes from "./routes/pushData.routes.js";
import whizunikRoutes from "./whizunik/routes.js";
import { whizunikOpenApi } from "./whizunik/openapi.js";
import { newRequestId } from "./utils/logger.js";
import { requireConnectorAuth } from "./middleware/connectorAuth.js";
import { rateLimiters } from "./middleware/rateLimiter.js";

const router = Router();

// Assign a request id to every request hitting the module (used in logs + audit)
router.use((req: Request, _res: Response, next: NextFunction) => {
  req.requestId = (req.headers["x-request-id"] as string) || newRequestId();
  next();
});

// Swagger/OpenAPI for the WhizUnik Cloud API (5 endpoints + admin)
router.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(whizunikOpenApi);
});

// Frontend (JWT-authenticated) routes — matched before the connector router
// so paths like /connectors are not shadowed by connector auth middleware.
router.use(statusRoutes);
router.use(pushDataRoutes);

// WhizUnik Cloud API (exact desktop-connector spec: connect, token,
// sync/batch, heartbeat, updates + admin pairing codes). Each handler only
// claims the NEW payload shape and calls next() otherwise, so the legacy
// connector router below keeps serving the existing integrations/tests.
router.use(whizunikRoutes);

// Connector (token/HMAC-authenticated) routes.
// /connect is public inside the connector router; everything else requires
// connector credentials (enforced inside connector.routes.ts).
router.use(connectorRoutes);

export default router;
