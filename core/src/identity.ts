/**
 * JSON-RPC `serverInfo` for the real core.
 * The fake core stays `cookie-fake-core` so the Swift shell can keep using it.
 */
export const CORE_SERVER_NAME = "cookie-core";

/** Matches `@cookie-agent/core` in package.json. Not read from disk at runtime. */
export const CORE_SERVER_VERSION = "0.0.0";

/**
 * M0 system prompt. There is no persona.md yet, and this build has no tools
 * and no hosted model. The provider also turns Qwen thinking off.
 */
export const SYSTEM_PROMPT =
  "You are Cookie, a local on-device assistant. Reply briefly. You cannot use tools, browse, or call a cloud model.";
