import {
  checkArray,
  checkEnum,
  checkName,
  checkObject,
  checkString,
  ID_PATTERN,
  Issues,
} from "./validate.ts";

export const STANDALONE_CONFIG_FILE = "coordination-kit.json";
export const STANDALONE_STATE_DIR = ".coordination-kit";
export const REVIEW_MODES = ["off", "chat", "pr"] as const;
export const PROJECT_PROVIDERS = ["github", "gitlab"] as const;
const GITHUB_MERGE_METHODS = ["merge", "squash", "rebase"] as const;

export interface StandaloneConfig {
  readonly schema: 1;
  readonly project: { readonly id: string; readonly roles: readonly string[] };
  readonly review: (typeof REVIEW_MODES)[number];
  readonly defaultBranch?: string;
  readonly remote?: string;
  readonly integration?: {
    readonly provider: (typeof PROJECT_PROVIDERS)[number];
    readonly repository: string;
    readonly requiredChecks?: readonly string[];
    readonly hostname?: string;
    readonly mergeMethod?: (typeof GITHUB_MERGE_METHODS)[number];
  };
}

const GIT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORGE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const CHECK_NAME = /^[^\p{C}]{1,128}$/u;

function safeSegment(segment: string, pattern: RegExp): boolean {
  return (
    pattern.test(segment) &&
    !segment.includes("..") &&
    !segment.endsWith(".") &&
    !segment.endsWith(".lock")
  );
}

function checkIntegration(issues: Issues, value: unknown): void {
  const at = "/integration";
  if (
    !checkObject(
      issues,
      at,
      {
        optional: ["requiredChecks", "hostname", "mergeMethod"],
        required: ["provider", "repository"],
      },
      value,
    )
  ) {
    return;
  }
  checkEnum(issues, `${at}/provider`, PROJECT_PROVIDERS, value.provider);
  if (checkString(issues, `${at}/repository`, null, value.repository)) {
    const parts = value.repository.split("/");
    if (
      parts.length < 2 ||
      (value.provider === "github" && parts.length !== 2) ||
      !parts.every((part) => safeSegment(part, FORGE_SEGMENT))
    ) {
      issues.add(`${at}/repository`, "must be a repository owner and path for the provider");
    }
  }
  if (
    value.requiredChecks !== undefined &&
    checkArray(issues, `${at}/requiredChecks`, { unique: true }, value.requiredChecks)
  ) {
    value.requiredChecks.forEach((name, index) => {
      const path = `${at}/requiredChecks/${index}`;
      if (checkString(issues, path, CHECK_NAME, name) && name.trim() !== name) {
        issues.add(path, "must not have leading or trailing whitespace");
      }
    });
  }
  if (value.hostname !== undefined) {
    if (value.provider !== "gitlab") {
      issues.add(`${at}/hostname`, "is only supported for GitLab");
    } else {
      checkString(issues, `${at}/hostname`, HOSTNAME, value.hostname);
    }
  }
  if (value.mergeMethod !== undefined) {
    if (value.provider !== "github") {
      issues.add(`${at}/mergeMethod`, "is only supported for GitHub");
    } else {
      checkEnum(issues, `${at}/mergeMethod`, GITHUB_MERGE_METHODS, value.mergeMethod);
    }
  }
}

export function validateStandaloneConfig(value: unknown): StandaloneConfig {
  const issues = new Issues();
  const shape = {
    optional: ["defaultBranch", "integration", "remote"],
    required: ["schema", "project", "review"],
  };
  if (checkObject(issues, "", shape, value)) {
    if (value.schema !== 1) {
      issues.add("/schema", "must be 1");
    }
    if (checkObject(issues, "/project", { required: ["id", "roles"] }, value.project)) {
      checkName(issues, "/project/id", ID_PATTERN, value.project.id);
      if (
        checkArray(issues, "/project/roles", { nonEmpty: true, unique: true }, value.project.roles)
      ) {
        value.project.roles.forEach((role, index) =>
          checkName(issues, `/project/roles/${index}`, ID_PATTERN, role),
        );
      }
    }
    checkEnum(issues, "/review", REVIEW_MODES, value.review);
    if (
      value.defaultBranch !== undefined &&
      checkString(issues, "/defaultBranch", null, value.defaultBranch) &&
      !value.defaultBranch.split("/").every((part) => safeSegment(part, GIT_SEGMENT))
    ) {
      issues.add("/defaultBranch", "must be a safe branch name");
    }
    if (
      value.remote !== undefined &&
      checkString(issues, "/remote", null, value.remote) &&
      !safeSegment(value.remote, GIT_SEGMENT)
    ) {
      issues.add("/remote", "must be a safe remote name");
    }
    if (value.integration !== undefined) {
      checkIntegration(issues, value.integration);
    }
  }
  issues.throwIfAny(STANDALONE_CONFIG_FILE);
  return value as StandaloneConfig;
}
