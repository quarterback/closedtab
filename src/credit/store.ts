import {
  existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  closeSync, writeFileSync, chmodSync, unlinkSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  SCORE_MAX, SCORE_MIN,
  newDomain, validateIdentity, assertValidDomain, assertValidEvent, isTier,
  type CreditEvent, type CreditIdentity, type CreditReport, type DomainCredit,
} from "./types.js";
import { foldProducts } from "./engine.js";

export function creditVaultDir(): string {
  return process.env.CLOSEDTAB_CREDIT_DIR || join(homedir(), ".closedtab");
}
export function ledgerPath(vault = creditVaultDir()): string {
  return join(vault, "agent_credit_report.json");
}
function assertNotSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing symlink for private credit path: ${path}`);
  }
}
export function ensureVault(vault = creditVaultDir()): string {
  assertNotSymlink(vault);
  mkdirSync(vault, { recursive: true, mode: 0o700 });
  assertNotSymlink(vault);
  chmodSync(vault, 0o700);
  return vault;
}
export function emptyReport(): CreditReport {
  return { version: "2.0.0", updated_at: new Date().toISOString(), events: [], products: {} };
}

/** A fresh, unused event id, short enough to type into `credit dispute`. */
export function newEventId(report: CreditReport): string {
  const taken = new Set(report.events.map((e) => e.id));
  for (;;) {
    const id = `ev_${randomBytes(5).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Ledger format 1.0.0 (the first prototype) stored only the current state on
 * a 0 to 10 scale. It becomes one baseline event per domain, with the score
 * mapped onto 100 to 600. Its session list is dropped; the private session
 * files under aars/ are left where they are.
 */
function migrateV1(data: Record<string, unknown>): CreditReport {
  const fail = (): never => { throw new Error("Invalid CT-ACE ledger version or structure; refusing unsafe fallback"); };
  const products = data.products;
  if (typeof data.updated_at !== "string" || !products || typeof products !== "object" || Array.isArray(products)) fail();
  const at = Number.isNaN(Date.parse(data.updated_at as string)) ? new Date().toISOString() : data.updated_at as string;
  const report = emptyReport();
  for (const [productId, product] of Object.entries(products as Record<string, unknown>)) {
    const domains = (product as { domains?: unknown })?.domains;
    if (!domains || typeof domains !== "object" || Array.isArray(domains)) fail();
    for (const [domain, raw] of Object.entries(domains as Record<string, unknown>)) {
      validateIdentity({ productId, domain });
      const old = raw as Record<string, any>;
      const v = old?.veracity_score;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10 ||
          !isTier(old.permission_tier) || !isTier(old.user_max_tier) ||
          !old.credit_limit || typeof old.credit_limit !== "object" ||
          !old.stats || typeof old.stats !== "object") fail();
      const state: DomainCredit = newDomain();
      state.score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round((SCORE_MIN + 50 * v) * 10) / 10));
      state.permission_tier = old.permission_tier;
      state.user_max_tier = old.user_max_tier;
      state.credit_limit = {
        allowed_paths: old.credit_limit.allowed_paths,
        blocked_actions: old.credit_limit.blocked_actions,
        allowed_actions: old.credit_limit.allowed_actions,
        financial_cap_usd: old.credit_limit.financial_cap_usd,
        min_scores: {},
      };
      state.stats = {
        ...state.stats,
        total_sessions: old.stats.total_sessions,
        reviewed_sessions: old.stats.reviewed_sessions,
        untouched_acceptances: old.stats.untouched_acceptances,
        untouched_acceptance_rate: old.stats.untouched_acceptance_rate,
        consecutive_successes: old.stats.consecutive_successes,
      };
      try { assertValidDomain(state); } catch { fail(); }
      report.events.push({ id: newEventId(report), at, product_id: productId, domain, type: "baseline", state });
    }
  }
  return report;
}

function parseReport(data: unknown): CreditReport {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid CT-ACE ledger version or structure; refusing unsafe fallback");
  }
  const raw = data as Record<string, unknown>;
  if (raw.version === "1.0.0") return withView(migrateV1(raw));
  if (raw.version !== "2.0.0" || typeof raw.updated_at !== "string" || !Array.isArray(raw.events)) {
    throw new Error("Invalid CT-ACE ledger version or structure; refusing unsafe fallback");
  }
  const ids = new Set<string>();
  for (const e of raw.events) {
    try { assertValidEvent(e); } catch (err) {
      throw new Error(`Invalid CT-ACE ledger: ${(err as Error).message}`);
    }
    if (ids.has(e.id)) throw new Error("Invalid CT-ACE ledger: duplicate event id");
    ids.add(e.id);
  }
  return withView({ version: "2.0.0", updated_at: raw.updated_at, events: raw.events as CreditEvent[], products: {} });
}

/** Recompute the snapshot from the events. The stored snapshot is never trusted. */
function withView(report: CreditReport): CreditReport {
  report.products = foldProducts(report.events);
  for (const product of Object.values(report.products)) {
    for (const domain of Object.values(product.domains)) assertValidDomain(domain);
  }
  return report;
}

export function readCreditReport(vault = creditVaultDir()): CreditReport {
  const path = ledgerPath(vault);
  assertNotSymlink(vault);
  assertNotSymlink(path);
  if (!existsSync(path)) return emptyReport();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid CT-ACE ledger: not readable JSON");
  }
  return parseReport(data);
}

/** Write the events (and a fresh snapshot) atomically. Prefer commitCreditEvents. */
export function writeCreditReport(report: CreditReport, vault = creditVaultDir()): string {
  const checked = parseReport(JSON.parse(JSON.stringify({ ...report, version: "2.0.0" })));
  ensureVault(vault);
  const path = ledgerPath(vault);
  assertNotSymlink(path);
  checked.updated_at = new Date().toISOString();
  const tmp = join(dirname(path), `.agent_credit_report-${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(checked, null, 2) + "\n", "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
  report.events = checked.events;
  report.products = checked.products;
  report.updated_at = checked.updated_at;
  return path;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * A lock file so two processes (a host's guard and the person's CLI, say)
 * can't both read the ledger, append, and overwrite each other's events.
 */
export function withVaultLock<T>(vault: string, fn: () => T): T {
  ensureVault(vault);
  const lock = join(vault, ".agent_credit_report.lock");
  assertNotSymlink(lock);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; }
      } catch { /* the holder just released it */ }
      if (Date.now() > deadline) throw new Error("The CT-ACE ledger is locked by another process; try again.");
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/**
 * The one way to change the record: under the vault lock, read the current
 * ledger, let `build` check it and return the events to append, then write.
 * `build` may throw to refuse the change; nothing is written in that case.
 */
export function commitCreditEvents(
  vault: string,
  build: (report: CreditReport) => CreditEvent[],
): CreditReport {
  return withVaultLock(vault, () => {
    const report = readCreditReport(vault);
    const events = build(report);
    for (const e of events) assertValidEvent(e);
    report.events.push(...events);
    writeCreditReport(report, vault);
    return report;
  });
}

export function initializeCreditReport(vault = creditVaultDir()): string {
  const path = ledgerPath(ensureVault(vault));
  if (!existsSync(path)) withVaultLock(vault, () => { if (!existsSync(path)) writeCreditReport(emptyReport(), vault); });
  return path;
}
export function getDomain(report: CreditReport, identity: CreditIdentity): DomainCredit {
  validateIdentity(identity);
  if (!Object.hasOwn(report.products, identity.productId)) return newDomain();
  const domains = report.products[identity.productId].domains;
  return Object.hasOwn(domains, identity.domain) ? domains[identity.domain] : newDomain();
}
/** For in-memory construction (tests, host adapters). Changes made here are not recorded. */
export function ensureDomain(report: CreditReport, identity: CreditIdentity): DomainCredit {
  validateIdentity(identity);
  if (!Object.hasOwn(report.products, identity.productId)) {
    Object.defineProperty(report.products, identity.productId, {
      value: { display_name: identity.productId, domains: {} },
      configurable: true, enumerable: true, writable: true,
    });
  }
  const domains = report.products[identity.productId].domains;
  if (!Object.hasOwn(domains, identity.domain)) {
    Object.defineProperty(domains, identity.domain, {
      value: newDomain(), configurable: true, enumerable: true, writable: true,
    });
  }
  return domains[identity.domain];
}
