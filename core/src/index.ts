/**
 * Cookie agent core entrypoint.
 *
 * Direct execution speaks protocol 0.1 on stdio and dials llama-server.
 * Importing this module does not start the loop. The fake core stays
 * `src/fake-core.ts` for the Swift shell.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startStdioCore } from "./stdio-core.ts";

export { CORE_SERVER_NAME, CORE_SERVER_VERSION } from "./identity.ts";
export { startStdioCore } from "./stdio-core.ts";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    return false;
  }
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  startStdioCore();
}
