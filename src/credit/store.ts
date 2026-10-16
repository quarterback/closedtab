import {
  existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  closeSync, writeFileSync, chmodSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  newDomain, validateIdentity, assertValidDomain, type CreditIdentity, type CreditReport,
  type DomainCredit,
} from "./types.js";

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
  return { version: "1.0.0", updated_at: new Date().toISOString(), products: {}, recent_aars: [] };
}
function isReport(data: unknown): data is CreditReport {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const report = data as Partial<CreditReport>;
  if (report.version !== "1.0.0" ||
      typeof report.updated_at !== "string" ||
      !report.products || typeof report.products !== "object" ||
      Array.isArray(report.products) || !Array.isArray(report.recent_aars)) return false;
  for (const [productId, product] of Object.entries(report.products)) {
    if (!product || typeof product !== "object" || Array.isArray(product)) return false;
    const p = product as CreditReport["products"][string];
    if (typeof p.display_name !== "string" ||
        !p.domains || typeof p.domains !== "object" || Array.isArray(p.domains)) return false;
    for (const [domain, credit] of Object.entries(p.domains)) {
      try {
        validateIdentity({ productId, domain });
        assertValidDomain(credit);
      } catch { return false; }
    }
  }
  for (const aar of report.recent_aars) {
    if (!aar || typeof aar !== "object" || typeof aar.aar_id !== "string" ||
        typeof aar.product_id !== "string" || typeof aar.domain !== "string" ||
        (aar.interaction_delta !== null &&
         (!Number.isFinite(aar.interaction_delta) || aar.interaction_delta < -1 || aar.interaction_delta > 1))) {
      return false;
    }
  }
  return true;
}
export function readCreditReport(vault = creditVaultDir()): CreditReport {
  const path = ledgerPath(vault);
  assertNotSymlink(vault);
  assertNotSymlink(path);
  if (!existsSync(path)) return emptyReport();
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isReport(data)) throw new Error("Invalid CT-ACE ledger version or structure; refusing unsafe fallback");
  return data;
}
export function writeCreditReport(report: CreditReport, vault = creditVaultDir()): string {
  if (!isReport(report)) throw new Error("Refusing to persist malformed CT-ACE report");
  ensureVault(vault);
  const path = ledgerPath(vault);
  assertNotSymlink(path);
  report.updated_at = new Date().toISOString();
  const tmp = join(dirname(path), `.agent_credit_report-${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(report, null, 2) + "\n", "utf8");
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
  return path;
}
export function initializeCreditReport(vault = creditVaultDir()): string {
  const path = ledgerPath(ensureVault(vault));
  if (!existsSync(path)) writeCreditReport(emptyReport(), vault);
  return path;
}
export function getDomain(report: CreditReport, identity: CreditIdentity): DomainCredit {
  validateIdentity(identity);
  if (!Object.hasOwn(report.products, identity.productId)) return newDomain();
  const domains = report.products[identity.productId].domains;
  return Object.hasOwn(domains, identity.domain) ? domains[identity.domain] : newDomain();
}
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
