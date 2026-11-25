import { expect, it } from "vitest";

import { TEST_CLOCK, TEST_HOST } from "../core/testFixtures.ts";
import { Store } from "../store/db.ts";
import { answerQuestion, cancelQuestion, openQuestion } from "../store/questions.ts";
import { COORDINATOR, GAME, TECH } from "../store/testStore.ts";
import { recordedDecisions } from "./recordedDecisions.ts";

it("reports pending store questions and recorded decision references by their owning role", () => {
  const store = Store.open(TEST_CLOCK, ":memory:");
  try {
    const tech = { nativeId: TECH, role: `${GAME}/tech` };
    const coordinator = { nativeId: COORDINATOR, role: "game-coordinator" };
    openQuestion(store, tech, { id: "q-palette", title: "Choose a palette", work: "ag-0001" });
    openQuestion(store, tech, { id: "q-font", title: "Choose a font" });
    openQuestion(store, coordinator, { id: "q-policy", title: "Choose a policy" });
    openQuestion(store, coordinator, { id: "q-cancelled", title: "Choose a different policy" });
    answerQuestion(TEST_HOST, store, tech, "q-palette", { text: "Warm.", work: "ag-0001" });
    answerQuestion(TEST_HOST, store, tech, "q-font", {
      text: "Keep the current one.",
      work: "ag-0001",
    });
    cancelQuestion(store, coordinator, "q-cancelled", "Already resolved");

    expect(recordedDecisions(store)).toEqual({
      pending: [{ id: "q-policy", role: "game-coordinator", work: null }],
      recorded: [
        {
          count: 2,
          latest: { id: "ag-0001/D2", question: "q-font", work: "ag-0001" },
          role: tech.role,
        },
      ],
    });
  } finally {
    store.close();
  }
});
