import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_UNCHECKED_ITEMS = 3;
const MAX_WORKFLOW_DOCS = 3;
const WORKFLOW_ARTIFACT_DEPTH = 5;
const SKIP_DIRS = new Set([
  ".git",
  ".pi",
  ".claude",
  ".agents",
  ".factory",
  ".context",
  "node_modules",
  "tmp",
]);
const WORKFLOW_NAME_PATTERN =
  /(^|[-_])(requirements?|brief|spec|roadmap|plan|todo|task[_-]?plan|task[_-]?list|progress|findings|worklog)([-_.]|$)/i;
const EXCLUDED_WORKFLOW_FILES = new Set([
  "readme.md",
  "changelog.md",
  "license.md",
  "copying.md",
  "contributing.md",
  "code_of_conduct.md",
  "handoff-system-prompt.md",
  "skill.md",
]);

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function toRepoRelative(cwd, filePath) {
  const relativePath = path.relative(cwd, filePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

function listMarkdownFiles(root, { maxDepth = Infinity, skipDirs = SKIP_DIRS } = {}) {
  if (!existsSync(root)) return [];

  const files = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || current.depth >= maxDepth) continue;
        stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function sortByModifiedDesc(filePaths) {
  return [...filePaths].sort((a, b) => {
    const aTime = safeStat(a)?.mtimeMs ?? 0;
    const bTime = safeStat(b)?.mtimeMs ?? 0;
    return bTime - aTime;
  });
}

function extractFrontmatter(content) {
  if (!content.startsWith("---\n")) return {};

  const end = content.indexOf("\n---", 4);
  if (end === -1) return {};

  const frontmatter = content.slice(4, end).split("\n");
  const values = {};

  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }

  return values;
}

function cleanInline(text) {
  return text
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHeading(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? cleanInline(match[1]) : null;
}

function extractUncheckedItems(content, limit = MAX_UNCHECKED_ITEMS) {
  const matches = [...content.matchAll(/^- \[ \] (.+)$/gm)];
  return matches.map((match) => cleanInline(match[1])).filter(Boolean).slice(0, limit);
}

function extractSectionFirstLine(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, "m"));
  if (!match) return null;

  return match[1]
    .split("\n")
    .map((line) => cleanInline(line))
    .find(Boolean) ?? null;
}

function summarizePlan(cwd) {
  const files = sortByModifiedDesc(listMarkdownFiles(path.join(cwd, "docs", "plans")));
  if (files.length === 0) return null;

  const summaries = files.map((filePath) => {
    const content = safeReadText(filePath);
    const frontmatter = extractFrontmatter(content);
    return {
      path: toRepoRelative(cwd, filePath),
      status: frontmatter.status ?? null,
      title: frontmatter.title ?? extractHeading(content),
      origin: frontmatter.origin ?? null,
      uncheckedItems: extractUncheckedItems(content),
      nextStep: extractSectionFirstLine(content, "Next Steps"),
      modifiedAt: safeStat(filePath)?.mtimeMs ?? 0,
    };
  });

  return summaries.find((summary) => summary.status === "active") ?? summaries[0];
}

function summarizeRequirements(cwd, activePlanOrigin) {
  const files = sortByModifiedDesc(listMarkdownFiles(path.join(cwd, "docs", "brainstorms")));
  if (files.length === 0) return null;

  const summaries = files.map((filePath) => {
    const content = safeReadText(filePath);
    return {
      path: toRepoRelative(cwd, filePath),
      title: extractHeading(content),
      nextStep: extractSectionFirstLine(content, "Next Steps"),
      modifiedAt: safeStat(filePath)?.mtimeMs ?? 0,
    };
  });

  const withoutOriginDuplicate = summaries.filter((summary) => summary.path !== activePlanOrigin);
  return withoutOriginDuplicate[0] ?? summaries[0] ?? null;
}

function isGenericWorkflowArtifact(relativePath) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const lowerPath = normalizedPath.toLowerCase();
  const baseName = path.basename(lowerPath);

  if (EXCLUDED_WORKFLOW_FILES.has(baseName)) return false;
  if (lowerPath.startsWith("docs/plans/") || lowerPath.startsWith("docs/brainstorms/")) return false;
  if (normalizedPath.split("/").includes("skills")) return false;

  return WORKFLOW_NAME_PATTERN.test(baseName) || WORKFLOW_NAME_PATTERN.test(lowerPath);
}

function scoreGenericWorkflowArtifact(relativePath, frontmatter, uncheckedItems, nextStep) {
  const lowerPath = relativePath.toLowerCase();
  let score = 0;

  if (lowerPath.startsWith("docs/")) score += 6;
  if (WORKFLOW_NAME_PATTERN.test(path.basename(lowerPath))) score += 5;
  if (lowerPath.includes("requirements")) score += 4;
  if (lowerPath.includes("plan")) score += 4;
  if (lowerPath.includes("todo") || lowerPath.includes("task_plan") || lowerPath.includes("task-plan")) score += 3;
  if (frontmatter.status === "active") score += 3;
  if (uncheckedItems.length > 0) score += 2;
  if (nextStep) score += 1;

  return score;
}

function summarizeWorkflowDocs(cwd, excludedPaths = []) {
  const excluded = new Set(excludedPaths.filter(Boolean));
  const files = listMarkdownFiles(cwd, { maxDepth: WORKFLOW_ARTIFACT_DEPTH });

  const summaries = files
    .map((filePath) => {
      const relativePath = toRepoRelative(cwd, filePath);
      if (excluded.has(relativePath)) return null;
      if (!isGenericWorkflowArtifact(relativePath)) return null;

      const content = safeReadText(filePath);
      const frontmatter = extractFrontmatter(content);
      const uncheckedItems = extractUncheckedItems(content);
      const nextStep = extractSectionFirstLine(content, "Next Steps");

      return {
        path: relativePath,
        title: frontmatter.title ?? extractHeading(content),
        status: frontmatter.status ?? null,
        uncheckedItems,
        nextStep,
        score: scoreGenericWorkflowArtifact(relativePath, frontmatter, uncheckedItems, nextStep),
        modifiedAt: safeStat(filePath)?.mtimeMs ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt);

  return summaries.slice(0, MAX_WORKFLOW_DOCS);
}

function formatArtifactLine(label, summary) {
  const parts = [summary.path];
  if (summary.title) parts.push(`title: ${summary.title}`);
  if (summary.status) parts.push(`status: ${summary.status}`);
  if (summary.uncheckedItems?.length > 0) {
    parts.push(`next unchecked: ${summary.uncheckedItems.join(" | ")}`);
  }
  if (summary.nextStep) parts.push(`next step: ${summary.nextStep}`);
  return `- ${label} -> ${parts.join("; ")}`;
}

export function discoverWorkflowContext(cwd) {
  const lines = [];
  const activePlan = summarizePlan(cwd);
  const requirements = summarizeRequirements(cwd, activePlan?.origin ?? null);
  const genericWorkflowDocs = summarizeWorkflowDocs(cwd, [activePlan?.path, requirements?.path, activePlan?.origin]);

  if (activePlan) {
    lines.push(formatArtifactLine("Active plan doc", activePlan));
  }

  if (requirements) {
    lines.push(formatArtifactLine("Latest requirements doc", requirements));
  }

  for (const summary of genericWorkflowDocs) {
    lines.push(formatArtifactLine("Other workflow markdown", summary));
  }

  return {
    activePlan,
    requirements,
    genericWorkflowDocs,
    lines,
  };
}

export function buildWorkflowContextBlock(cwd) {
  const workflowContext = discoverWorkflowContext(cwd);
  if (workflowContext.lines.length === 0) return "";

  return [
    "Structured workflow context was found in the workspace. Prefer these markdown artifacts over freeform continuation when they match the latest preserved session:",
    ...workflowContext.lines,
  ].join("\n");
}
