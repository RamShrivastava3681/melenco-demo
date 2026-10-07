/**
 * DynamoDB single-table access layer.
 *
 * Table: process.env.DYNAMODB_TABLE_PREFIX (full table name, e.g. "mickey-mouse")
 * Keys: pk (HASH) + sk (RANGE). No GSIs — per-tenant access via Query(pk),
 * global lookups (email, connector_id, code_hash, session_state, batch_id)
 * via Scan with filters. Fine at this app's scale; add GSIs later if needed.
 *
 * Backends:
 *  - Real DynamoDB (DynamoDBDocumentClient) in production.
 *  - In-memory Map when USE_MEMORY_DB=1 / NODE_ENV=test / VITEST is set,
 *    so `npm test` runs without AWS credentials.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

export interface DbItem {
  pk: string;
  sk: string;
  recordType: string;
  [key: string]: any;
}

function useMemoryDb(): boolean {
  if (process.env.USE_MEMORY_DB === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VITEST) return true;
  if (process.env.VITEST_POOL_ID) return true;
  return false;
}

export function tableName(): string {
  const t = process.env.DYNAMODB_TABLE_PREFIX || process.env.DYNAMODB_TABLE || "mickey-mouse";
  return t;
}

let docClient: DynamoDBDocumentClient | null = null;

function client(): DynamoDBDocumentClient {
  if (!docClient) {
    const region = process.env.AWS_REGION || "ap-south-1";
    const endpoint = process.env.DYNAMODB_ENDPOINT || undefined;
    const base = new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) });
    docClient = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

export function isMemoryMode(): boolean {
  return useMemoryDb();
}

// --- In-memory store (tests / local dev without AWS) ---
const memStore = new Map<string, DbItem>();

function memKey(pk: string, sk: string): string {
  return `${pk}|${sk}`;
}

export function clearMemoryDb(): void {
  memStore.clear();
}

function stripKey(item: DbItem): Record<string, any> {
  const { pk, sk, ...rest } = item;
  return rest;
}

export async function dbPut(item: DbItem): Promise<void> {
  if (useMemoryDb()) {
    memStore.set(memKey(item.pk, item.sk), { ...item });
    return;
  }
  await client().send(new PutCommand({ TableName: tableName(), Item: { ...item } }));
}

export async function dbGet<T = DbItem>(pk: string, sk: string): Promise<T | undefined> {
  if (useMemoryDb()) {
    return memStore.get(memKey(pk, sk)) as unknown as T | undefined;
  }
  const res = await client().send(new GetCommand({ TableName: tableName(), Key: { pk, sk } }));
  return res.Item as unknown as T | undefined;
}

export async function dbDelete(pk: string, sk: string): Promise<void> {
  if (useMemoryDb()) {
    memStore.delete(memKey(pk, sk));
    return;
  }
  await client().send(new DeleteCommand({ TableName: tableName(), Key: { pk, sk } }));
}

/** Partial update: sets attrs (skips undefined). Returns the updated item. */
export async function dbUpdate<T = DbItem>(
  pk: string,
  sk: string,
  attrs: Record<string, any>
): Promise<T | undefined> {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) clean[k] = v;
  }
  if (useMemoryDb()) {
    const existing = memStore.get(memKey(pk, sk));
    if (!existing) return undefined;
    const next = { ...existing, ...clean };
    memStore.set(memKey(pk, sk), next);
    return next as unknown as T;
  }
  if (Object.keys(clean).length === 0) {
    return dbGet<T>(pk, sk);
  }
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  const sets: string[] = [];
  let i = 0;
  for (const [k, v] of Object.entries(clean)) {
    const n = `#a${i}`;
    const p = `:v${i}`;
    names[n] = k;
    values[p] = v;
    sets.push(`${n} = ${p}`);
    i++;
  }
  const res = await client().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk, sk },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return res.Attributes as unknown as T | undefined;
}

/** Query all items under one pk, optionally filtered by sk prefix. */
export async function dbQueryPk(pk: string, skPrefix?: string): Promise<DbItem[]> {
  if (useMemoryDb()) {
    const out: DbItem[] = [];
    for (const item of memStore.values()) {
      if (item.pk !== pk) continue;
      if (skPrefix && !item.sk.startsWith(skPrefix)) continue;
      out.push({ ...item });
    }
    return out;
  }
  const out: DbItem[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await client().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: skPrefix ? "pk = :pk AND begins_with(sk, :pre)" : "pk = :pk",
        ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":pre": skPrefix } : { ":pk": pk },
        ExclusiveStartKey: lastKey,
      })
    );
    for (const it of (res.Items || []) as DbItem[]) out.push(it);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/**
 * Scan the whole table with an optional in-memory predicate.
 * Used for global lookups (email, connector_id, code_hash, session_state,
 * batch_id) where no GSI exists yet. Paginates fully — fine at this scale.
 */
export async function dbScan(predicate?: (item: DbItem) => boolean, limit?: number): Promise<DbItem[]> {
  if (useMemoryDb()) {
    const out: DbItem[] = [];
    for (const item of memStore.values()) {
      if (!predicate || predicate(item)) {
        out.push({ ...item });
        if (limit && out.length >= limit) break;
      }
    }
    return out;
  }
  const out: DbItem[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await client().send(
      new ScanCommand({ TableName: tableName(), ExclusiveStartKey: lastKey })
    );
    for (const it of (res.Items || []) as DbItem[]) {
      if (!predicate || predicate(it)) {
        out.push(it);
        if (limit && out.length >= limit) return out;
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** Find first item of a recordType matching extra equality checks (scan-based, strict equality). */
export async function dbFindOne(
  recordType: string,
  match: Record<string, any>
): Promise<DbItem | undefined> {
  const keys = Object.keys(match);
  const found = await dbScan((it) => {
    if (it.recordType !== recordType) return false;
    for (const k of keys) {
      const want = match[k];
      if (want === null) {
        if (it[k] !== null && it[k] !== undefined) return false;
      } else if (it[k] !== want) {
        return false;
      }
    }
    return true;
  }, 2);
  return found[0];
}

/** Case-insensitive match on a single string attribute (e.g. LOWER(name) lookups). */
export async function dbFindOneCI(
  recordType: string,
  attr: string,
  value: string,
  extra?: Record<string, any>
): Promise<DbItem | undefined> {
  const want = value.toLowerCase();
  const extraKeys = Object.keys(extra || {});
  const found = await dbScan((it) => {
    if (it.recordType !== recordType) return false;
    if (typeof it[attr] !== "string" || (it[attr] as string).toLowerCase() !== want) return false;
    for (const k of extraKeys) {
      if (it[k] !== (extra as Record<string, any>)[k]) return false;
    }
    return true;
  }, 2);
  return found[0];
}

export { stripKey };
