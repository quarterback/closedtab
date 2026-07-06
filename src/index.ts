// Public library surface. The CLI and the MCP server are thin wrappers over
// these exports; all three call the identical reconcile() core.

export * from "./types.js";
export { parseTrace } from "./parseTrace.js";
export { parseAarTestimony } from "./parseAar.js";
export { reconcile, matchLevel } from "./reconcile.js";
export { extractEntities } from "./entities.js";
export { classifyHeading } from "./anchors.js";

// Doc authoring (the Agent Action Record + task variants)
export { TEMPLATES, getTemplate, isFielded, isPrivateOnly } from "./templates.js";
export type { Template, SectionSpec, Field, MetaField } from "./templates.js";
export { renderAar, slugify, docFilename, aarFilename } from "./renderAar.js";
export type { AarMeta, Answers } from "./renderAar.js";

// Private context (gitignored companion + local recall)
export {
  forkPrivate,
  hasPrivate,
  wrapPrivate,
  redactionStub,
  ensureIgnored,
  privateStoreDir,
  privateCompanionPath,
  privateName,
  resolveInStore,
  writePrivateDoc,
  writePrivateNote,
  listPrivateNotes,
  readPrivateNote,
} from "./private.js";
export type { ForkResult, PrivateRegion, PrivateListing } from "./private.js";
export { GUIDE } from "./guide.js";
export { checkDoc, formatCheck } from "./check.js";
export type { CheckResult, QualityDimension } from "./check.js";

import { parseTrace } from "./parseTrace.js";
import { parseAarTestimony } from "./parseAar.js";
import { reconcile } from "./reconcile.js";
import type { ReconciliationDiff } from "./types.js";

/**
 * One-call convenience: testimony markdown + trace text (JSON array or JSONL)
 * in, reconciliation diff out. This is the headline entry point used by the CLI
 * and the MCP server.
 */
export function reconcileText(
  testimonyMarkdown: string,
  traceText: string,
): ReconciliationDiff {
  const claims = parseAarTestimony(testimonyMarkdown);
  const trace = parseTrace(traceText);
  return reconcile(claims, trace);
}
