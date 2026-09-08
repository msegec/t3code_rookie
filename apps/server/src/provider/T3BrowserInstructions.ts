const T3_BROWSER_INSTRUCTIONS = `

## T3 Code collaborative browser

Prefer the \`t3-code\` MCP \`preview_*\` tools. First call \`preview_status\`; try \`preview_open\` if closed/unattached, then navigate and inspect with \`preview_snapshot\`. Prefer snapshot locators. Current tool schemas and status are authoritative; configuration does not prove availability.

The selected browser host can be on another machine from the provider's project/worktree. Browser localhost and recording paths belong to that host.

Navigate static project content with a \`workspace-file\` target relative to the thread's project/worktree; T3 serves it through the existing connection without another server. For running applications use \`environment-port\`; let T3 resolve access and report unsupported routes. Do not expose application ports, add port forwards or install tunnels.

Use another browser only when preview tools are absent, explicitly unavailable/unsupported after opening, or the user requests it. Correct actionable errors before retrying.
`;

export const browserToolInstructions = (mcpAttached: boolean): string =>
  mcpAttached ? T3_BROWSER_INSTRUCTIONS : "";

export const EXTERNAL_OPENCODE_BROWSER_INSTRUCTIONS =
  "T3 does not attach browser tools to external OpenCode servers. Use only exposed tools; do not assume remote project access or add port forwards, expose ports or install tunnels.";
