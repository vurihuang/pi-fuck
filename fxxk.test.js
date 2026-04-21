import test from "node:test";
import assert from "node:assert/strict";

import { buildHandoffPromptFromMessages, decideFxxkAction } from "./fxxk-core.js";

test("decideFxxkAction stages the current session when it has usable history", () => {
  assert.equal(
    decideFxxkAction({
      hasCurrentSessionHistory: true,
      hasPendingStagedPrompt: false,
    }),
    "stage-current-session",
  );
});

test("decideFxxkAction consumes a staged prompt in a child session", () => {
  assert.equal(
    decideFxxkAction({
      hasCurrentSessionHistory: false,
      hasPendingStagedPrompt: true,
    }),
    "consume-staged-prompt",
  );
});

test("decideFxxkAction warns when there is no staged prompt to consume", () => {
  assert.equal(
    decideFxxkAction({
      hasCurrentSessionHistory: false,
      hasPendingStagedPrompt: false,
    }),
    "warn-no-staged-prompt",
  );
});

test("decideFxxkAction prioritizes staging the current session once the child session has its own history", () => {
  assert.equal(
    decideFxxkAction({
      hasCurrentSessionHistory: true,
      hasPendingStagedPrompt: true,
    }),
    "stage-current-session",
  );
});

test("buildHandoffPromptFromMessages reuses an explicit handoff prompt from the source messages", async () => {
  const prompt = await buildHandoffPromptFromMessages({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Give me a prompt I can paste into a new session to continue this task." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Use this exactly:\n\n```text\nContinue the staged handoff flow and finish the remaining verification.\n```" }],
      },
    ],
    goal: "",
    cwd: "/repo",
    sessionInfo: { path: "session.jsonl", cwd: "/repo", id: "source-session" },
    workflowContext: { activePlan: null, requirements: null, genericWorkflowDocs: [], lines: [] },
    completePrompt: async () => {
      throw new Error("completePrompt should not run when an explicit handoff prompt already exists");
    },
  });

  assert.equal(prompt, "Continue the staged handoff flow and finish the remaining verification.");
});

test("buildHandoffPromptFromMessages uses current-session evidence when generating a new handoff prompt", async () => {
  let receivedEvidenceBlock = "";

  const prompt = await buildHandoffPromptFromMessages({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Refactor the /fxxk flow so the source session stages a prompt for /new." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will split prompt generation from child-session consumption next." }],
      },
    ],
    goal: "preserve end-to-end handoff verification",
    cwd: "/repo",
    sessionInfo: { path: "session.jsonl", cwd: "/repo", id: "source-session" },
    workflowContext: { activePlan: null, requirements: null, genericWorkflowDocs: [], lines: [] },
    completePrompt: async ({ evidenceBlock }) => {
      receivedEvidenceBlock = evidenceBlock;
      return "Stage this exact handoff prompt for the next session.";
    },
  });

  assert.equal(prompt, "Stage this exact handoff prompt for the next session.");
  assert.match(receivedEvidenceBlock, /Goal: preserve end-to-end handoff verification/);
  assert.match(receivedEvidenceBlock, /Refactor the \/fxxk flow so the source session stages a prompt for \/new\./);
});

test("buildHandoffPromptFromMessages falls back to deterministic continuation when completePrompt returns null", async () => {
  const prompt = await buildHandoffPromptFromMessages({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Finish the handoff refactor and report the next natural step" }],
      },
    ],
    goal: "",
    cwd: "/repo",
    sessionInfo: { path: "session.jsonl", cwd: "/repo", id: "source-session" },
    workflowContext: { activePlan: null, requirements: null, genericWorkflowDocs: [], lines: [] },
    completePrompt: async () => null,
  });

  assert.match(prompt, /Finish the handoff refactor and report the next natural step\./);
  assert.match(prompt, /Do not redo finished work or invent extra scope\./);
});
