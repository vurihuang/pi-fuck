import { readFileSync } from "node:fs";

import { complete } from "@mariozechner/pi-ai";
import { BorderedLoader, SessionManager } from "@mariozechner/pi-coding-agent";

import { discoverWorkflowContext } from "./workflow-context.js";

const HANDOFF_SYSTEM_PROMPT = readFileSync(new URL("./handoff-system-prompt.md", import.meta.url), "utf8").trim();
const MAX_RECENT_USER_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 500;
const MAX_ASSISTANT_CHARS = 1000;
const MAX_FILE_COUNT = 8;

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text, maxChars) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function ensureSentence(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?。]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function isLowSignalMessage(text) {
  return /^(continue|go on|继续|继续吧|继续。)$/i.test(normalizeText(text));
}

function getSessionLabel(session) {
  if (session.name?.trim()) return session.name.trim();
  if (session.firstMessage?.trim()) return session.firstMessage.trim().slice(0, 60);
  return session.id;
}

function getPromptText(response) {
  const directOutputText = typeof response?.output_text === "string" ? response.output_text.trim() : "";
  if (directOutputText) {
    return directOutputText;
  }

  if (!Array.isArray(response?.content)) {
    return "";
  }

  const exactTextBlocks = response.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (exactTextBlocks) {
    return exactTextBlocks;
  }

  return response.content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      return typeof item.text === "string" && item.text.trim() ? [item.text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function getRetryMessage() {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: "Your previous reply was empty. Return the actual next user message now. Do not summarize the whole session or leave the response blank.",
      },
    ],
    timestamp: Date.now(),
  };
}

function formatWorkflowContextBlock(workflowContext) {
  if (!workflowContext || workflowContext.lines.length === 0) return "";

  return [
    "Structured workflow context was found in the workspace. Prefer these markdown artifacts when they clearly define the next task:",
    ...workflowContext.lines,
  ].join("\n");
}

function getWorkflowTarget(workflowContext) {
  return workflowContext.activePlan ?? workflowContext.requirements ?? workflowContext.genericWorkflowDocs[0] ?? null;
}

function hasExplicitWorkflowTask(target) {
  return Boolean(target && ((target.uncheckedItems?.length ?? 0) > 0 || target.nextStep || target.status === "active"));
}

function extractMessageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return normalizeText(message.content);
  if (!Array.isArray(message.content)) return "";

  return normalizeText(
    message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n"),
  );
}

function collectRecentMessageSnippets(messages, role, maxCount, maxChars) {
  return messages
    .filter((message) => message?.role === role)
    .map(extractMessageText)
    .filter((text) => text && !isLowSignalMessage(text))
    .slice(-maxCount)
    .map((text) => truncateText(text, maxChars));
}

function collectFileEvidence(messages) {
  const modifiedFiles = [];
  const readFiles = [];
  const modified = new Set();
  const read = new Set();

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (block?.type !== "toolCall" || !block.name || typeof block.arguments !== "object" || !block.arguments) {
        continue;
      }

      const filePath = typeof block.arguments.path === "string" ? block.arguments.path : null;
      if (!filePath) continue;

      if (block.name === "edit" || block.name === "write") {
        if (!modified.has(filePath)) {
          modified.add(filePath);
          modifiedFiles.push(filePath);
        }
        read.delete(filePath);
        continue;
      }

      if (block.name === "read" && !modified.has(filePath) && !read.has(filePath)) {
        read.add(filePath);
        readFiles.push(filePath);
      }
    }
  }

  return {
    modifiedFiles: modifiedFiles.slice(-MAX_FILE_COUNT),
    readFiles: readFiles.filter((filePath) => !modified.has(filePath)).slice(-MAX_FILE_COUNT),
  };
}

function buildCompactEvidence(previousMessages, goal, cwd, previousSessionInfo, workflowContext) {
  const recentUserMessages = collectRecentMessageSnippets(
    previousMessages,
    "user",
    MAX_RECENT_USER_MESSAGES,
    MAX_MESSAGE_CHARS,
  );
  const latestAssistantText = collectRecentMessageSnippets(previousMessages, "assistant", 1, MAX_ASSISTANT_CHARS)[0] ?? "";
  const { modifiedFiles, readFiles } = collectFileEvidence(previousMessages);
  const lines = [];

  lines.push(`Working directory: ${cwd}`);
  if (previousSessionInfo.cwd && previousSessionInfo.cwd !== cwd) {
    lines.push(`Relevant previous-session cwd: ${previousSessionInfo.cwd}`);
  }

  const trimmedGoal = goal.trim();
  if (trimmedGoal) {
    lines.push(`Goal: ${trimmedGoal}`);
  } else {
    lines.push("Goal: infer the next concrete task and write the actual user message that should be sent now.");
  }

  const workflowBlock = formatWorkflowContextBlock(workflowContext);
  if (workflowBlock) {
    lines.push("");
    lines.push(workflowBlock);
  }

  if (recentUserMessages.length > 0) {
    lines.push("");
    lines.push("Most recent user requests:");
    for (const message of recentUserMessages) {
      lines.push(`- ${message}`);
    }
  }

  if (latestAssistantText) {
    lines.push("");
    lines.push("Latest assistant status/report:");
    lines.push(`- ${latestAssistantText}`);
  }

  if (modifiedFiles.length > 0) {
    lines.push("");
    lines.push("Recently modified files:");
    for (const filePath of modifiedFiles) {
      lines.push(`- ${filePath}`);
    }
  }

  if (readFiles.length > 0) {
    lines.push("");
    lines.push("Recently read-only files:");
    for (const filePath of readFiles) {
      lines.push(`- ${filePath}`);
    }
  }

  return {
    recentUserMessages,
    latestAssistantText,
    modifiedFiles,
    readFiles,
    block: lines.join("\n"),
  };
}

function buildFallbackHandoff(previousSessionInfo, goal, cwd, workflowContext, evidence) {
  const target = getWorkflowTarget(workflowContext);
  const goalLine = goal.trim();

  if (target) {
    const taskSentence = target.uncheckedItems?.length > 0
      ? `Read ${target.path} first. Then resume this pending work: ${ensureSentence(target.uncheckedItems[0])}`
      : target.nextStep
        ? `Read ${target.path} first. Then follow this documented next step: ${ensureSentence(target.nextStep)}`
        : `Read ${target.path} first and use it as the source of truth for the next task.`;

    const lines = [taskSentence, ""];
    if (target.title) lines.push(`- Workflow file: ${target.path} (${target.title}).`);
    else lines.push(`- Workflow file: ${target.path}.`);
    if (target.status) lines.push(`- Status: ${target.status}.`);
    if (target.uncheckedItems?.length > 0) {
      lines.push(`- Pending work: ${target.uncheckedItems.join(" | ")}.`);
    }
    if (target.nextStep) {
      lines.push(`- Documented next step: ${target.nextStep}.`);
    }
    if (goalLine) {
      lines.push(`- Session goal: ${goalLine}.`);
    }
    if (previousSessionInfo.cwd && previousSessionInfo.cwd !== cwd) {
      lines.push(`- Relevant previous-session cwd: ${previousSessionInfo.cwd}.`);
    }
    lines.push("- Do not redo finished work or invent extra scope.");
    lines.push("- Report back with what you completed, which files changed, and the next natural step.");
    return lines.join("\n");
  }

  const lastUserMessage = evidence.recentUserMessages.length > 0
    ? evidence.recentUserMessages[evidence.recentUserMessages.length - 1]
    : "";
  const firstSentence = goalLine
    ? ensureSentence(goalLine)
    : lastUserMessage
      ? ensureSentence(lastUserMessage)
      : evidence.modifiedFiles.length > 0
        ? `Read ${evidence.modifiedFiles.join(", ")} first and continue the next unfinished task.`
        : "Inspect the latest changed files and continue the next unfinished task.";

  const lines = [firstSentence, ""];
  if (evidence.modifiedFiles.length > 0) {
    lines.push(`- Read these files first: ${evidence.modifiedFiles.join(", ")}.`);
  } else if (evidence.readFiles.length > 0) {
    lines.push(`- Inspect these files first: ${evidence.readFiles.join(", ")}.`);
  }
  if (evidence.latestAssistantText) {
    lines.push(`- Latest confirmed status: ${evidence.latestAssistantText}`);
  }
  if (previousSessionInfo.cwd && previousSessionInfo.cwd !== cwd) {
    lines.push(`- Relevant previous-session cwd: ${previousSessionInfo.cwd}.`);
  }
  lines.push("- Do not redo finished work or invent extra scope.");
  lines.push("- Report back with what you completed, which files changed, and the next natural step.");
  return lines.join("\n");
}

function summarizeResponseShape(response) {
  const blockTypes = Array.isArray(response?.content)
    ? response.content.map((item) => item?.type ?? typeof item).join(", ") || "none"
    : "none";
  const hasOutputText = typeof response?.output_text === "string" && response.output_text.length > 0;
  return `stopReason=${response?.stopReason ?? "unknown"}; contentTypes=${blockTypes}; hasOutputText=${hasOutputText}`;
}

async function loadPreviousSession(ctx) {
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
  return sessions.find((session) => session.path !== currentSessionFile);
}

async function buildHandoffPrompt(ctx, previousSessionInfo, goal, signal) {
  const previousSession = SessionManager.open(previousSessionInfo.path, ctx.sessionManager.getSessionDir());
  const previousBranch = previousSession.getBranch();
  const previousMessages = previousBranch
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  const hasUsableHistory = previousMessages.length > 0 || previousBranch.some((entry) => entry.type === "compaction" || entry.type === "branch_summary");

  if (!hasUsableHistory) {
    throw new Error("The previous session does not contain usable message content.");
  }

  const workflowContext = discoverWorkflowContext(ctx.cwd);
  const evidence = buildCompactEvidence(previousMessages, goal, ctx.cwd, previousSessionInfo, workflowContext);
  const workflowTarget = getWorkflowTarget(workflowContext);

  if (hasExplicitWorkflowTask(workflowTarget)) {
    return buildFallbackHandoff(previousSessionInfo, goal, ctx.cwd, workflowContext, evidence);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
  }

  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "Compact continuation evidence follows. Write the actual next user message to send now.",
            "Do not summarize the whole session or add handoff narration.",
            "",
            evidence.block,
          ].join("\n"),
        },
      ],
      timestamp: Date.now(),
    },
  ];

  const response = await complete(
    ctx.model,
    {
      systemPrompt: HANDOFF_SYSTEM_PROMPT,
      messages,
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === "aborted") {
    return null;
  }

  const prompt = getPromptText(response);
  if (prompt) {
    return prompt;
  }

  const retryResponse = await complete(
    ctx.model,
    {
      systemPrompt: HANDOFF_SYSTEM_PROMPT,
      messages: [...messages, getRetryMessage()],
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (retryResponse.stopReason === "aborted") {
    return null;
  }

  const retryPrompt = getPromptText(retryResponse);
  if (retryPrompt) {
    return retryPrompt;
  }

  console.warn(
    "/fuck falling back to deterministic continuation after two empty model responses:",
    summarizeResponseShape(response),
    summarizeResponseShape(retryResponse),
  );

  return buildFallbackHandoff(previousSessionInfo, goal, ctx.cwd, workflowContext, evidence);
}

async function generatePromptWithLoader(ctx, previousSessionInfo, goal) {
  const sessionLabel = getSessionLabel(previousSessionInfo);

  if (!ctx.hasUI) {
    return buildHandoffPrompt(ctx, previousSessionInfo, goal);
  }

  const result = await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, `Reading ${sessionLabel} and composing the next user message...`);
    loader.onAbort = () => done({ prompt: null, error: null });

    buildHandoffPrompt(ctx, previousSessionInfo, goal, loader.signal)
      .then((prompt) => done({ prompt, error: null }))
      .catch((error) => {
        console.error("/fuck generation failed:", error);
        done({ prompt: null, error: error instanceof Error ? error.message : String(error) });
      });

    return loader;
  });

  if (!result || result.error || !result.prompt) {
    if (result?.error) {
      throw new Error(result.error);
    }
    return null;
  }

  return result.prompt;
}

async function runFuck(pi, args, ctx) {
  if (!ctx.model) {
    ctx.ui.notify("/fuck requires an active model.", "error");
    return;
  }

  const previousSessionInfo = await loadPreviousSession(ctx);
  if (!previousSessionInfo) {
    ctx.ui.notify("No previous session was found for this workspace.", "warning");
    return;
  }

  let prompt;
  try {
    prompt = await generatePromptWithLoader(ctx, previousSessionInfo, args.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return;
  }

  if (!prompt) {
    ctx.ui.notify("/fuck was cancelled.", "info");
    return;
  }

  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
  } else {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  ctx.ui.notify(
    `Sent a continuation message from ${getSessionLabel(previousSessionInfo)}`,
    "info",
  );
}

export default function fuckExtension(pi) {
  pi.registerCommand("fuck", {
    description: "Read the previous session, compose the next continuation message, and send it automatically",
    handler: async (args, ctx) => {
      await runFuck(pi, args, ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (!text || text.startsWith("/")) {
      return { action: "continue" };
    }

    if (text === "fuck" || text.startsWith("fuck ")) {
      await runFuck(pi, text === "fuck" ? "" : text.slice(4).trim(), ctx);
      return { action: "handled" };
    }

    return { action: "continue" };
  });
}
