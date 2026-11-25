import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK } from "../core/io.ts";
import { loadLayout } from "../core/layout.ts";
import { makeFixture, registryInput } from "../core/testFixtures.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { reportWork } from "./report.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "delivery-kit");

function coordinator(): string {
  const { root } = makeFixture();
  createRegistry(
    loadLayout(root),
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
  return root;
}

describe("reportWork", () => {
  it("reports front matter only without a coordinator root", () => {
    const report = reportWork(undefined, FIXTURE);
    expect(report.coordinator).toEqual({ status: "absent" });
    expect(report.items).toHaveLength(18);
    expect(report.items[0]).toEqual({
      design: "review",
      id: "dk-0001",
      path: "docs/work/dk-0001.md",
      status: "done",
      title: "Accept Claude route targets in inbox snapshot and ack",
    });
    expect(report.items.find((item) => item.id === "dk-0018")?.status).toBe("approved");
    expect(report.items.some((item) => "publications" in item)).toBe(false);
  });

  it("reports proposed and declined milestones as written", () => {
    const repository = mkdtempSync(join(tmpdir(), "work-report-"));
    cpSync(FIXTURE, repository, { recursive: true });
    for (const [id, status] of [
      ["dk-0002", "proposed"],
      ["dk-0003", "declined"],
    ] as const) {
      const path = join(repository, "docs", "work", `${id}.md`);
      writeFileSync(path, readFileSync(path, "utf8").replace(/^status: .*$/m, `status: ${status}`));
    }
    const items = reportWork(undefined, repository).items;
    expect(items.find((item) => item.id === "dk-0002")?.status).toBe("proposed");
    expect(items.find((item) => item.id === "dk-0003")?.status).toBe("declined");
  });

  it("names an available coordinator and keeps front matter only", () => {
    const root = coordinator();
    const report = reportWork(root, FIXTURE);
    expect(report.coordinator).toEqual({ root, status: "available" });
    expect(report.items.some((item) => "publications" in item)).toBe(false);
  });

  it("reports an unreadable coordinator as unavailable, never as absent work", async () => {
    const report = reportWork("/nonexistent/coordinator", FIXTURE);
    expect(report.coordinator).toMatchObject({ status: "unavailable" });
    expect(report.items.some((item) => "publications" in item)).toBe(false);
    let out = "";
    const code = await main(
      {
        cwd: FIXTURE,
        env: { DELIVERY_KIT_ROOT: "/nonexistent/coordinator" },
        err: () => undefined,
        out: (text) => (out += text),
      },
      ["work", "report"],
    );
    expect(code).toBe(EXIT_INVALID);
    expect(JSON.parse(out).coordinator.status).toBe("unavailable");
  });

  it("reads the coordinator root from COORDINATION_KIT_ROOT before DELIVERY_KIT_ROOT", async () => {
    const root = coordinator();
    let out = "";
    const code = await main(
      {
        cwd: "/nonexistent",
        env: { COORDINATION_KIT_ROOT: root, DELIVERY_KIT_ROOT: "/nonexistent/coordinator" },
        err: () => undefined,
        out: (text) => (out += text),
      },
      ["work", "report", "--root", FIXTURE],
    );
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(out).coordinator).toEqual({ root, status: "available" });
  });
});
