Write the actual user message that should be sent now.

The job is continuity: make the current session continue the real pending work without rediscovering the previous session.

Return only that message.
No preface, no explanation, no code fences, and no quoted labels.
Avoid meta phrases like "here's a handoff", "based on the previous session", or anything that sounds like a summary wrapper.

Treat the output as a normal user instruction.
Lead with the next action, not a recap.
Do not summarize the whole session. Use only the smallest amount of context needed to make the next action clear.

Use only evidence from the previous session and the provided session metadata.
Do not invent files, commands, results, decisions, blockers, approvals, or status.
If the conversation was trimmed or compact evidence was provided, prefer the explicit goal, workflow artifacts, latest preserved requests, latest confirmed status, and concrete file evidence.
If earlier and later evidence conflict, trust the later evidence.
If structured workflow markdown artifacts are provided and they clearly match the latest preserved session, prefer them over freeform continuation.

If a goal is given, use it.
If no goal is given, infer the smallest concrete next task from the evidence. That may be implementation, debugging, review, planning, research, or brainstorming.

Prefer the smallest useful next step.
If the evidence already contains an explicit pending next step, preserve that step instead of inventing a better one.
When a matching workflow markdown artifact exists, anchor the message to that artifact:
- read or continue the relevant `requirements`, `plan`, `todo`, `task_plan`, or similar workflow document first
- preserve its explicit unchecked items, next-step section, or active status when present
- prefer artifact-defined continuation over generic "continue implementation" wording
Do not ask the next agent to repeat work that is already done.
Do not introduce extra validation, sanity checks, or closeout work unless:
- the previous session explicitly left that work pending, or
- the session appears finished and no clearer next step exists.
Reuse exact paths, commands, constraints, decisions, and checks when they are present.
If the current working directory and the previous-session cwd differ, mention the relevant path explicitly.

Include only details that help the next agent act immediately:
- where to work
- what to read first
- what is already done
- what is still pending or unresolved
- the immediate next task or decision
- constraints or decisions to preserve
- checks to run
- what to report back

Prefer this default shape when the evidence supports it:
1. one sentence with the next action
2. short bullets with essential context

Do not end with a generic question unless the previous session clearly ended on an explicit user-facing decision.
If the previous session appears finished and there is no explicit pending step, ask for the highest-value follow-up that is actually supported by the evidence.
If the evidence is thin, say what should be inspected first instead of guessing.

Write in English.
Be direct, self-contained, concise, and easy to act on.
Aim for roughly 60-140 words unless the evidence truly requires more.
Prefer a compact paragraph plus short bullets only when they improve clarity.
