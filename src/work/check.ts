// `work check`: the work-file convention over one repository's docs/design index tables and
// docs/work front matter. Findings name the file, line and rule; matched private text is never
// echoed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONVENTION_FILE,
  DESIGN_DIR,
  type DesignFile,
  field,
  OPTIONAL_FIELDS,
  readDesignFiles,
  readWorkFiles,
  REQUIRED_FIELDS,
  STATUSES,
  WORK_DIR,
  type WorkFile,
} from "./files.ts";

export type FindingCode =
  | "design-unknown"
  | "field-invalid"
  | "field-missing"
  | "field-unknown"
  | "front-matter-invalid"
  | "front-matter-missing"
  | "home-path"
  | "id-duplicate"
  | "id-invalid"
  | "id-mismatch"
  | "index-area-mismatch"
  | "index-duplicate"
  | "index-id-mismatch"
  | "index-link-unresolved"
  | "session-uuid"
  | "status-invalid"
  | "supersedes-missing"
  | "unindexed"
  | "work-dir-missing";

export interface Finding {
  readonly path: string;
  readonly line?: number;
  readonly code: FindingCode;
  readonly message: string;
}

export interface WorkCheck {
  readonly ok: boolean;
  readonly workItems: number;
  readonly designAreas: number;
  readonly findings: readonly Finding[];
}

/** `<prefix>-` and a zero-padded sequence of at least four digits, for example ck-0001. */
export const ID_PATTERN = /^[a-z][a-z0-9]*-\d{4,}$/;
const HOME_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+|(?<![\w.-])\/root(?=\/)/;
const SESSION_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const KNOWN_FIELDS: ReadonlySet<string> = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

function frontMatterFindings(file: WorkFile): Finding[] {
  const { path } = file;
  if (file.frontMatter === null) {
    return [{ code: "front-matter-missing", message: "does not open with ---", path }];
  }
  const findings: Finding[] = file.frontMatter.problems.map((problem) => ({
    code: "front-matter-invalid",
    message: problem,
    path,
  }));
  const { fields } = file.frontMatter;
  for (const key of REQUIRED_FIELDS) {
    const value = fields[key];
    if (value === undefined) {
      findings.push({ code: "field-missing", message: `${key} is required`, path });
    } else if (typeof value !== "string" || value === "") {
      findings.push({ code: "field-invalid", message: `${key} must be a non-empty value`, path });
    }
  }
  for (const key of Object.keys(fields)
    .filter((name) => !KNOWN_FIELDS.has(name))
    .sort()) {
    findings.push({ code: "field-unknown", message: `${key} is not a work-file field`, path });
  }
  const related = fields.related;
  if (related !== undefined && (typeof related === "string" || related.some((id) => id === ""))) {
    findings.push({ code: "field-invalid", message: "related must be a list of IDs", path });
  }
  const supersedes = fields.supersedes;
  if (supersedes !== undefined && (typeof supersedes !== "string" || supersedes === "")) {
    findings.push({ code: "field-invalid", message: "supersedes must be one ID", path });
  }
  const id = field(file, "id");
  if (id !== undefined && id !== "") {
    if (!ID_PATTERN.test(id)) {
      findings.push({
        code: "id-invalid",
        message: "id must be a prefix and a zero-padded sequence, such as ck-0001",
        path,
      });
    }
    if (id !== file.stem) {
      findings.push({ code: "id-mismatch", message: `id ${id} differs from the file name`, path });
    }
  }
  const status = field(file, "status");
  if (status !== undefined && status !== "" && !(STATUSES as readonly string[]).includes(status)) {
    findings.push({
      code: "status-invalid",
      message: `status must be one of ${STATUSES.join(", ")}`,
      path,
    });
  }
  return findings;
}

function privacyFindings(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    if (HOME_PATH.test(line)) {
      findings.push({
        code: "home-path",
        line: index + 1,
        message: "contains a home-directory absolute path",
        path,
      });
    }
    if (SESSION_UUID.test(line)) {
      findings.push({
        code: "session-uuid",
        line: index + 1,
        message: "contains a session UUID pattern",
        path,
      });
    }
  });
  return findings;
}

function idFindings(files: readonly WorkFile[]): Finding[] {
  const byId = new Map<string, WorkFile[]>();
  for (const file of files) {
    const id = field(file, "id");
    if (id !== undefined && id !== "") {
      byId.set(id, [...(byId.get(id) ?? []), file]);
    }
  }
  const findings: Finding[] = [];
  for (const [id, holders] of byId) {
    if (holders.length > 1) {
      for (const file of holders) {
        findings.push({
          code: "id-duplicate",
          message: `id ${id} is also used by ${holders
            .filter((other) => other !== file)
            .map((other) => other.path)
            .join(", ")}`,
          path: file.path,
        });
      }
    }
  }
  for (const file of files) {
    const target = field(file, "supersedes");
    if (target !== undefined && target !== "" && !byId.has(target)) {
      findings.push({
        code: "supersedes-missing",
        message: `supersedes ${target}, which is not a work item`,
        path: file.path,
      });
    }
    const design = field(file, "design");
    if (design !== undefined && design !== "" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(design)) {
      findings.push({
        code: "field-invalid",
        message: "design must name an area",
        path: file.path,
      });
    }
  }
  return findings;
}

function indexFindings(
  root: string,
  designs: readonly DesignFile[],
  files: readonly WorkFile[],
): Finding[] {
  const findings: Finding[] = [];
  const areas = new Set(designs.map((design) => design.area));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const indexed = new Map<string, { path: string; line: number; area: string }[]>();
  for (const design of designs) {
    for (const row of design.rows) {
      const at = { line: row.line, path: row.path };
      if (!existsSync(join(root, row.resolved))) {
        findings.push({
          ...at,
          code: "index-link-unresolved",
          message: `link ${row.target} does not resolve`,
        });
        continue;
      }
      const file = byPath.get(row.resolved);
      if (file === undefined) {
        continue;
      }
      indexed.set(file.path, [...(indexed.get(file.path) ?? []), { ...at, area: design.area }]);
      const id = field(file, "id");
      if (id !== undefined && row.id !== id) {
        findings.push({
          ...at,
          code: "index-id-mismatch",
          message: `row ID ${row.id} differs from the linked item's id ${id}`,
        });
      }
    }
  }
  for (const file of files) {
    const rows = indexed.get(file.path) ?? [];
    const design = field(file, "design");
    if (design !== undefined && design !== "" && !areas.has(design)) {
      findings.push({
        code: "design-unknown",
        message: `design ${design} has no ${DESIGN_DIR}/${design}.md`,
        path: file.path,
      });
    }
    if (rows.length === 0) {
      findings.push({
        code: "unindexed",
        message: "is not listed in any design index table",
        path: file.path,
      });
      continue;
    }
    if (rows.length > 1) {
      for (const row of rows) {
        findings.push({
          code: "index-duplicate",
          line: row.line,
          message: `${file.path} is indexed more than once`,
          path: row.path,
        });
      }
    }
    for (const row of rows) {
      if (design !== undefined && design !== "" && areas.has(design) && row.area !== design) {
        findings.push({
          code: "index-area-mismatch",
          line: row.line,
          message: `${file.path} has design ${design} but is indexed in ${row.area}`,
          path: row.path,
        });
      }
    }
  }
  return findings;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Path, line, code and message in code-point order, the same under every locale. */
function order(left: Finding, right: Finding): number {
  return (
    compare(left.path, right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    compare(left.code, right.code) ||
    compare(left.message, right.message)
  );
}

/** Check `root`'s docs/design index tables and docs/work files against the convention. */
export function checkWork(root: string): WorkCheck {
  const findings: Finding[] = [];
  if (!existsSync(join(root, WORK_DIR))) {
    findings.push({ code: "work-dir-missing", message: "does not exist", path: WORK_DIR });
  }
  const files = readWorkFiles(root);
  const designs = readDesignFiles(root);
  for (const file of files) {
    findings.push(...frontMatterFindings(file), ...privacyFindings(file.path, file.text));
  }
  const convention = join(WORK_DIR, CONVENTION_FILE);
  if (existsSync(join(root, convention))) {
    findings.push(...privacyFindings(convention, readFileSync(join(root, convention), "utf8")));
  }
  for (const design of designs) {
    findings.push(...privacyFindings(design.path, design.text));
  }
  findings.push(...idFindings(files), ...indexFindings(root, designs, files));
  findings.sort(order);
  return {
    designAreas: designs.length,
    findings,
    ok: findings.length === 0,
    workItems: files.length,
  };
}
