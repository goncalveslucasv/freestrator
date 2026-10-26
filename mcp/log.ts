// stdout carries the MCP protocol, so diagnostics go to stderr.
export const log = (...args: unknown[]) => console.error("[freestrator-mcp]", ...args);
