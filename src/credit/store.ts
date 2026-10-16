import {
  existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  closeSync, writeFileSync, chmodSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  newDomain, validateIdentity, type CreditIdentity, type CreditReport,
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
  if (!data || typeof data !== "object") return false;
  const r = data as Partial<CreditReport>;
  return r.version === "1.0.0" && !!r.products && typeof r.products === "object" &&
    !Array.isArray(r.products) && Array.isArray(r.recent_aars);
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
  return report.products[identity.productId]?.domains[identity.domain] ?? newDomain();
}
export function ensureDomain(report: CreditReport, identity: CreditIdentity): DomainCredit {
  validateIdentity(identity);
  if (!report.products[identity.productId]) {
    report.products[identity.productId] = { display_name: identity.productId, domains: {} };
  }
  return (report.products[identity.productId].domains[identity.domain] ??= newDomain());
}
