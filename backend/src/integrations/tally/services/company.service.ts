import {
  getCompany,
  findCompanyByGuid,
  listCompanies,
  createCompany,
} from "../../../db/storesTally.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.service.js";
import type { DbItem } from "../../../db/dynamo.js";

export interface CompanyRow extends DbItem {
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
export async function ensureCompany(params: {
  userId: string;
  tallyCompanyGuid: string;
  tallyCompanyName: string;
  requestId?: string;
}): Promise<CompanyRow> {
  const existing = (await findCompanyByGuid(params.userId, params.tallyCompanyGuid)) as CompanyRow | undefined;

  if (existing) return existing;

  try {
    await createCompany(params.userId, params.tallyCompanyGuid, params.tallyCompanyName);
  } catch {
    // Lost a race — re-read
    const again = (await findCompanyByGuid(params.userId, params.tallyCompanyGuid)) as CompanyRow | undefined;
    if (again) return again;
    throw new ApiError("DATABASE_ERROR", "Failed to register Tally company");
  }

  audit("COMPANY_MAPPED", {
    userId: params.userId,
    requestId: params.requestId,
    detail: { tallyCompanyGuid: params.tallyCompanyGuid, tallyCompanyName: params.tallyCompanyName },
  });

  const created = (await findCompanyByGuid(params.userId, params.tallyCompanyGuid)) as CompanyRow;
  return created;
}

/** Validate that a company row belongs to the tenant; 403 otherwise. */
export async function requireCompanyAccess(userId: string, companyRowId: string): Promise<CompanyRow> {
  const row = (await getCompany(userId, companyRowId)) as CompanyRow | undefined;
  if (!row) {
    throw new ApiError("INVALID_COMPANY", "Company not found for this account");
  }
  return row;
}

export async function listCompaniesForUser(userId: string): Promise<CompanyRow[]> {
  return (await listCompanies(userId)) as CompanyRow[];
}
