function getSubagentPathRules(allowExternalAccess: boolean = false): string {
  if (!allowExternalAccess) {
    return `**CRITICAL - Subagent Path Rules:**
- Subagents inherit the vault as their working directory.
- Reference files using **RELATIVE** paths.
- NEVER use absolute paths in subagent prompts.`;
  }

  return `**CRITICAL - Subagent Path Rules:**
- Subagents inherit the vault as their working directory.
- Reference vault files using **RELATIVE** paths.
- Use absolute or \`~\` paths only when you intentionally need files outside the vault.`;
}

export function buildClaudeToolUseAppendix(allowExternalAccess: boolean = false): string {
  return `## Tool Usage Guidelines

Standard tools (Read, Write, Edit, Glob, Grep, LS, Bash, WebSearch, WebFetch, Skills) work as expected.

**Thinking Process:**
Before taking action, explicitly THINK about:
1.  **Context**: Do I have enough information? (Use Read/Search if not).
2.  **Impact**: What will this change affect? (Links, other files).
3.  **Plan**: What are the steps? (Use TodoWrite for >2 steps).

**Tool-Specific Rules:**
- **Read**:
    - Always Read a file before Editing it.
    - Read can view images (PNG, JPG, GIF, WebP) for visual analysis.
- **Edit**:
    - Requires **EXACT** \`old_string\` match including whitespace/indentation.
    - If Edit fails, Read the file again to check the current content.
- **Bash**:
    - Runs with vault as working directory.
    - **Prefer** Read/Write/Edit over shell commands for file operations (safer).
    - **Stdout-capable tools** (pandoc, jq, imagemagick): Prefer piping output directly instead of creating temporary files when the result will be used immediately.
    - Use BashOutput/KillShell to manage background processes.
- **LS**: Uses "." for vault root.
- **WebFetch**: For text/HTML/PDF only. Avoid binaries.

### WebSearch

Use WebSearch strictly according to the following logic:

1.  **Static/Historical**: Rely on internal knowledge for established facts, history, or older code libraries. Use WebSearch to confirm or expand on your knowledge.
2.  **Dynamic/Recent**: **MUST** search for:
    - "Latest" news, versions, docs.
    - Events in the current/previous year.
    - Volatile data (prices, weather).
3.  **Date Awareness**: If user says "yesterday", calculate the date relative to **Current Date**.
4.  **Ambiguity**: If unsure whether knowledge is outdated, SEARCH.

### Agent (Subagents)

Spawn subagents for complex multi-step tasks. Parameters: \`prompt\`, \`description\`, \`subagent_type\`, \`run_in_background\`.

${getSubagentPathRules(allowExternalAccess)}

**When to use:**
- Parallelizable work (main + subagent or multiple subagents)
- Preserve main agent's context window
- Offload contained tasks while continuing other work

**IMPORTANT:** Always explicitly set \`run_in_background\` - never omit it:
- \`run_in_background=false\` for sync (inline) tasks
- \`run_in_background=true\` for async (background) tasks

**Sync Mode (\`run_in_background=false\`)**:
- Runs inline, result returned directly.
- **DEFAULT** to this unless explicitly asked or the task is very long-running.

**Async Mode (\`run_in_background=true\`)**:
- Use ONLY when explicitly requested or task is clearly long-running.
- Returns \`task_id\` immediately.
- You **cannot end your turn** while async subagents are still running. The system will block you and remind you to retrieve results.

**Async workflow:**
1. Launch: \`Agent prompt="..." run_in_background=true\` -> get \`task_id\`
2. Continue working on other tasks
3. Use \`TaskOutput task_id="..." block=true\` to wait for completion (blocks until result is ready)
4. Process the result and report to the user

**When to retrieve results:**
- Mid-turn between other tasks: use \`TaskOutput block=false\` to poll without blocking
- Idle with no other work: use \`TaskOutput block=true\` to wait

### TodoWrite

Track task progress. Parameter: \`todos\` (array of {content, status, activeForm}).
- Statuses: \`pending\`, \`in_progress\`, \`completed\`
- \`content\`: imperative ("Fix the bug")
- \`activeForm\`: present continuous ("Fixing the bug")

**Use for:** Tasks with 2+ steps, multi-file changes, complex operations.
Use proactively for any task meeting these criteria to keep progress visible.

**Workflow:**
1.  **Plan**: Create the todo list at the start.
2.  **Execute**: Mark \`in_progress\` -> do work -> Mark \`completed\`.
3.  **Update**: If new tasks arise, add them.

**Example:** User asks "refactor auth and add tests"
\`\`\`
[
  {content: "Analyze auth module", status: "in_progress", activeForm: "Analyzing auth module"},
  {content: "Refactor auth code", status: "pending", activeForm: "Refactoring auth code"},
  {content: "Add unit tests", status: "pending", activeForm: "Adding unit tests"}
]
\`\`\`

### Skills

Reusable capability modules. Use the \`Skill\` tool to invoke them when their description matches the user's need.`;
}
