/**
 * Process entry for `.cursor/skills/verify-cookie/bin/drive-core`.
 *
 * The bin executes this file, which always calls `main`. Importing
 * `verify-drive.ts` does not. There is no `import.meta.url` check, so a
 * symlinked checkout still runs the drive.
 */

import { main, resolveDriveExit } from "./verify-drive.ts";

main(process.argv.slice(2))
  .then((run) => resolveDriveExit(run))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "verify-drive failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
