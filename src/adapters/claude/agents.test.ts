import { describe, expect, it } from "vitest";

import { RECIPIENT } from "../../review/fixtures.ts";
import { recipientAvailability } from "./agents.ts";

const interactive = (status: unknown) => ({ kind: "interactive", sessionId: RECIPIENT, status });

describe("recipientAvailability", () => {
  it.each(["idle", "busy", "shell", "waiting"])("accepts the live %s status", (status) => {
    expect(recipientAvailability([interactive(status)], RECIPIENT)).toEqual({ status });
  });

  it.each([
    ["an unrecognized status", [interactive("starting")], "starting"],
    [
      "a background state",
      [{ kind: "background", sessionId: RECIPIENT, state: "running" }],
      "running",
    ],
    [
      "a live status beside a state",
      [{ sessionId: RECIPIENT, state: "running", status: "waiting" }],
      "running",
    ],
    ["a token outside the reported pattern", [interactive("Waiting <now>")], "unknown"],
    ["a non-string status", [interactive(7)], "unknown"],
  ])("defers %s and names the reported token", (_name, entries, token) => {
    expect(recipientAvailability(entries, RECIPIENT)).toEqual({
      reason: `recipient session state unknown (reported: ${token})`,
      status: null,
    });
  });

  it("keeps the missing and blocked reasons", () => {
    expect(recipientAvailability([], RECIPIENT)).toEqual({
      reason: "recipient session missing from claude agents listing",
      status: null,
    });
    expect(
      recipientAvailability(
        [interactive("idle"), { kind: "background", sessionId: RECIPIENT, state: "blocked" }],
        RECIPIENT,
      ),
    ).toEqual({ reason: "recipient session blocked", status: null });
  });
});
