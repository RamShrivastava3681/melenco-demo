import { v4 as uuidv4 } from "uuid";
import db from "../../../db/index.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.service.js";

export interface CompanyRow {
  id: string;
  user_id: string;
  tally_company_guid: string;
  tally_company_name: string;
  display_name: string | null;
  created_at: string;
}

/**
 * Find or create the tally company for a tenant, keyed by Tally's company GUID.
 * Returns the internal company row id used across all tally_* tables.
 */
export function ensureCompany(params: {
  userId: string;
  tallyCompanyGuid: string;
  tallyCompanyName: string;
  requestId?: string;
}): CompanyRow {
  const existing = db
    .prepare(
      `SELECT * FROM tally_companies WHERE user_id = ? AND tally_company_guid = ?`
    )
    .get(params.userId, params.tallyCompanyGuid) as CompanyRow | undefined;

  if (existing) return existing;

  const id = uuidv4();
  try {
    db.prepare(
      `INSERT INTO tally_companies (id, user_id, tally_company_guid, tally_company_name)
       VALUES (?, ?, ?, ?)`
    ).run(id, params.userId, params.tallyCompanyGuid, params.tallyCompanyName);
  } catch {
    // Lost a race — re-read
    const again = db
      .prepare(`SELECT * FROM tally_companies WHERE user_id = ? AND tally_company_guid = ?`)
      .get(params.userId, params.tallyCompanyGuid) as CompanyRow | undefined;
    if (again) return again;
    throw new ApiError("DATABASE_ERROR", "Failed to register Tally company");
  }

  audit("COMPANY_MAPPED", {
    userId: params.userId,
    requestId: params.requestId,
    detail: { tallyCompanyGuid: params.tallyCompanyGuid, tallyCompanyName: params.tallyCompanyName },
  });

  const created = db
    .prepare(`SELECT * FROM tally_companies WHERE id = ?`)
    .get(id) as CompanyRow;
  return created;
}

/** Validate that a company row belongs to the tenant; 403 otherwise. */
export function requireCompanyAccess(userId: string, companyRowId: string): CompanyRow {
  const row = db
    .prepare(`SELECT * FROM tally_companies WHERE id = ? AND user_id = ?`)
    .get(companyRowId, userId) as CompanyRow | undefined;
  if (!row) {
    throw new ApiError("INVALID_COMPANY", "Company not found for this account");
  }
  return row;
}

export function listCompaniesForUser(userId: string): CompanyRow[] {
  return db
    .prepare(`SELECT * FROM tally_companies WHERE user_id = ? ORDER BY created_at`)
    .all(userId) as CompanyRow[];
}
