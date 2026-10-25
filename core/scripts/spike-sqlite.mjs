/**
 * Repeatable spike for node:sqlite on Node 22.13.0.
 *
 * Capabilities, each printed as `name: PASS|FAIL ...`:
 *   wal            PRAGMA journal_mode=WAL on a file database
 *   fts5           FTS5 virtual table, insert, and MATCH
 *   sqlite-vec-knn sqlite-vec loadExtension, a vec0 table, and a KNN query
 *
 * On 22.13.0 the module loads without --experimental-sqlite. Importing it
 * still prints ExperimentalWarning. Child probes run with
 * --disable-warning=ExperimentalWarning, which is the narrowest flag that
 * removes that warning, and a deliberate stderr write must still show up.
 *
 * This script exits 1 when any capability or launch check fails. A failing
 * result stops M1 Step 0. It is not a prompt to switch SQLite libraries.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE = "v22.13.0";
const SQLITE_WARNING = "ExperimentalWarning: SQLite is an experimental feature";
const QUIET_FLAG = "--disable-warning=ExperimentalWarning";
const MODE_ENV = "COOKIE_SPIKE_SQLITE_MODE";
const scriptPath = fileURLToPath(import.meta.url);

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function oneLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll("\n", " ");
}

function report(name, ok, detail) {
  process.stdout.write(`${name}: ${ok ? "PASS" : "FAIL"} ${detail}\n`);
  return ok;
}

function f32(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

function requireNode() {
  if (process.version === REQUIRED_NODE) {
    return true;
  }
  process.stdout.write(
    `node: FAIL ${process.version} (this spike requires ${REQUIRED_NODE})\n`,
  );
  process.exitCode = 1;
  return false;
}

async function runCapabilities() {
  if (!requireNode()) {
    return;
  }

  let failed = 0;
  const pass = (name, detail) => {
    report(name, true, detail);
  };
  const fail = (name, detail) => {
    report(name, false, detail);
    failed += 1;
  };

  process.stdout.write(`platform: ${process.platform} ${process.arch}\n`);
  process.stdout.write(`node: ${process.version}\n`);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    process.stdout.write("sqlite: unknown\n");
    process.stdout.write("sqlite-vec: unknown\n");
    fail("wal", oneLine(error));
    fail("fts5", oneLine(error));
    fail("sqlite-vec-knn", oneLine(error));
    process.exitCode = 1;
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "cookie-spike-sqlite-"));
  try {
    const db = new DatabaseSync(join(dir, "wal.db"));
    try {
      const versionRow = db.prepare("select sqlite_version() as v").get();
      process.stdout.write(`sqlite: ${versionRow?.v ?? "unknown"}\n`);

      const wal = db.prepare("PRAGMA journal_mode = WAL").get();
      const journalMode = String(wal?.journal_mode ?? "").toLowerCase();
      if (journalMode === "wal") {
        pass("wal", "journal_mode=wal");
      } else {
        fail("wal", `journal_mode=${journalMode || "missing"}`);
      }

      const options = db
        .prepare("PRAGMA compile_options")
        .all()
        .map((row) => row.compile_options);
      const ftsFlag = options.includes("ENABLE_FTS5")
        ? "ENABLE_FTS5 present"
        : "ENABLE_FTS5 absent";
      try {
        db.exec("CREATE VIRTUAL TABLE spike_fts USING fts5(text)");
        db.prepare("INSERT INTO spike_fts(text) VALUES (?)").run(
          "ece midterm friday",
        );
        const hits = db
          .prepare("SELECT text FROM spike_fts WHERE spike_fts MATCH ?")
          .all("midterm");
        if (hits.length === 1 && hits[0]?.text === "ece midterm friday") {
          pass("fts5", `match=1 (${ftsFlag})`);
        } else {
          fail("fts5", `unexpected rows ${JSON.stringify(hits)} (${ftsFlag})`);
        }
      } catch (error) {
        fail("fts5", `${oneLine(error)} (${ftsFlag})`);
      }
    } finally {
      db.close();
    }

    let sqliteVecVersion = "unknown";
    let printedVecVersion = false;
    const printVecVersion = () => {
      if (printedVecVersion) {
        return;
      }
      printedVecVersion = true;
      process.stdout.write(`sqlite-vec: ${sqliteVecVersion}\n`);
    };
    try {
      const sqliteVec = await import("sqlite-vec");
      const entry = createRequire(import.meta.url).resolve("sqlite-vec");
      const pkg = JSON.parse(
        readFileSync(join(dirname(entry), "package.json"), "utf8"),
      );
      sqliteVecVersion = String(pkg.version);
      printVecVersion();

      const extension = sqliteVec.getLoadablePath();
      const vecDb = new DatabaseSync(join(dir, "vec.db"), {
        allowExtension: true,
      });
      let blockedLoaded = false;
      const blocked = new DatabaseSync(join(dir, "blocked.db"));
      try {
        sqliteVec.load(vecDb);
        const loaded = vecDb.prepare("select vec_version() as v").get();
        vecDb.exec(
          "CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3])",
        );
        const insert = vecDb.prepare(
          "INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)",
        );
        insert.run(1n, f32([1, 0, 0]));
        insert.run(2n, f32([0, 1, 0]));
        const rows = vecDb
          .prepare(
            "SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = 2 ORDER BY distance",
          )
          .all(f32([1, 0, 0]));
        try {
          sqliteVec.load(blocked);
          blockedLoaded = true;
        } catch {
          blockedLoaded = false;
        }
        const nearest = rows[0];
        const nearestId =
          nearest === undefined ? "none" : String(nearest.rowid);
        const distance =
          nearest === undefined ? "none" : String(nearest.distance);
        if (blockedLoaded) {
          fail(
            "sqlite-vec-knn",
            "loadExtension succeeded without allowExtension",
          );
        } else if (
          rows.length === 2 &&
          nearestId === "1" &&
          Number(nearest.distance) < 1e-5
        ) {
          pass(
            "sqlite-vec-knn",
            `vec_version=${loaded?.v ?? "unknown"} extension=${basename(extension)} nearest=${nearestId} distance=${distance} allowExtension=required`,
          );
        } else {
          fail(
            "sqlite-vec-knn",
            `rows=${JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`,
          );
        }
      } finally {
        vecDb.close();
        blocked.close();
      }
    } catch (error) {
      printVecVersion();
      fail("sqlite-vec-knn", oneLine(error));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.exitCode = failed === 0 ? 0 : 1;
}

const importOkSource = `
import("node:sqlite").then(({ DatabaseSync }) => {
  const db = new DatabaseSync(":memory:");
  const version = db.prepare("select sqlite_version() as v").get().v;
  db.close();
  process.stdout.write("import-ok " + version + "\\n");
}).catch((error) => {
  process.stderr.write(String(error.stack ?? error) + "\\n");
  process.exitCode = 1;
});
`.trim();

const importDisabledSource = `
import("node:sqlite").then(() => {
  process.stdout.write("import-ok\\n");
}).catch((error) => {
  process.stdout.write("import-disabled " + String(error.code) + "\\n");
});
`.trim();

const noisySource = `
import("node:sqlite").then(({ DatabaseSync }) => {
  const db = new DatabaseSync(":memory:");
  db.close();
  process.stderr.write("real-error\\n");
}).catch((error) => {
  process.stderr.write(String(error.stack ?? error) + "\\n");
  process.exitCode = 1;
});
`.trim();

function childEnv(extra) {
  const env = { ...process.env };
  delete env[MODE_ENV];
  return { ...env, ...extra };
}

async function runSpike() {
  if (!requireNode()) {
    return;
  }

  const bare = await run(["-e", importOkSource], childEnv());
  const flagged = await run(
    ["--experimental-sqlite", "-e", importOkSource],
    childEnv(),
  );
  const disabled = await run(
    ["--no-experimental-sqlite", QUIET_FLAG, "-e", importDisabledSource],
    childEnv(),
  );
  const quiet = await run([QUIET_FLAG, "-e", importOkSource], childEnv());
  const noisy = await run([QUIET_FLAG, "-e", noisySource], childEnv());
  const capabilities = await run(
    [QUIET_FLAG, scriptPath],
    childEnv({ [MODE_ENV]: "capabilities" }),
  );

  const flagOk =
    bare.code === 0 &&
    bare.stdout.startsWith("import-ok ") &&
    bare.stderr.includes(SQLITE_WARNING) &&
    flagged.code === 0 &&
    flagged.stdout.startsWith("import-ok ") &&
    flagged.stderr.includes(SQLITE_WARNING) &&
    disabled.code === 0 &&
    disabled.stdout === "import-disabled ERR_UNKNOWN_BUILTIN_MODULE\n";

  const warningOk =
    quiet.code === 0 &&
    quiet.stderr === "" &&
    quiet.stdout.startsWith("import-ok ") &&
    noisy.code === 0 &&
    noisy.stderr === "real-error\n" &&
    capabilities.stderr === "";

  const flagDetail = flagOk
    ? "not required (import succeeds with no flag and with --experimental-sqlite; both still warn; --no-experimental-sqlite returns ERR_UNKNOWN_BUILTIN_MODULE)"
    : `bare code=${String(bare.code)} stdout=${JSON.stringify(bare.stdout)} stderr=${JSON.stringify(bare.stderr)} flagged code=${String(flagged.code)} stdout=${JSON.stringify(flagged.stdout)} stderr=${JSON.stringify(flagged.stderr)} disabled code=${String(disabled.code)} stdout=${JSON.stringify(disabled.stdout)} stderr=${JSON.stringify(disabled.stderr)}`;

  const warningDetail = warningOk
    ? "ExperimentalWarning removed by --disable-warning=ExperimentalWarning; capability stderr empty; real stderr line preserved"
    : `quiet code=${String(quiet.code)} stdout=${JSON.stringify(quiet.stdout)} stderr=${JSON.stringify(quiet.stderr)} noisy code=${String(noisy.code)} stderr=${JSON.stringify(noisy.stderr)} capability stderr=${JSON.stringify(capabilities.stderr)}`;

  const flagPassed = report("sqlite-flag", flagOk, flagDetail);
  const warningPassed = report("sqlite-warning", warningOk, warningDetail);
  process.stdout.write(capabilities.stdout);
  if (capabilities.stdout.length > 0 && !capabilities.stdout.endsWith("\n")) {
    process.stdout.write("\n");
  }

  const capabilitiesFailed =
    capabilities.code !== 0 || capabilities.stdout.includes(": FAIL");
  const ok = flagPassed && warningPassed && !capabilitiesFailed;
  report("spike", ok, ok ? "wal fts5 sqlite-vec" : "one or more checks failed");
  process.exitCode = ok ? 0 : 1;
}

if (process.env[MODE_ENV] === "capabilities") {
  await runCapabilities();
} else {
  await runSpike();
}
