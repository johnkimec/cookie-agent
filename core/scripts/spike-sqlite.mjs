/**
 * Repeatable spike for better-sqlite3 on Node 22.13.0.
 *
 * Capabilities, each printed as `name: PASS|FAIL ...`:
 *   prebuild        the install unpacked a prebuild; node-gyp did not compile
 *   wal             PRAGMA journal_mode=WAL on a file database
 *   fts5            FTS5 virtual table, insert, MATCH, and bm25() order
 *   sqlite-vec-knn  db.loadExtension of the sqlite-vec binary, vec0, and KNN
 *
 * The process must keep stderr empty. Children that load the library pass
 * --disable-warning=ExperimentalWarning, the same narrow flag as the rest
 * of the core. A deliberate stderr write must still show up.
 *
 * This script exits 1 on any failure. It requires Node v22.13.0.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE = "v22.13.0";
const SQLITE_WARNING = "ExperimentalWarning:";
const QUIET_FLAG = "--disable-warning=ExperimentalWarning";
const MODE_ENV = "COOKIE_SPIKE_SQLITE_MODE";
const INSTALL_SCRIPT = "prebuild-install || node-gyp rebuild --release";
const scriptPath = fileURLToPath(import.meta.url);
const coreDir = fileURLToPath(new URL("..", import.meta.url));

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: coreDir,
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

function prebuildState() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("better-sqlite3/package.json");
  const root = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const binary = join(root, "build", "Release", "better_sqlite3.node");
  const makefile = existsSync(join(root, "build", "Makefile"));
  const gypi = existsSync(join(root, "build", "config.gypi"));
  const objects = existsSync(join(root, "build", "Release", "obj"));
  const install = pkg.scripts?.install ?? "";
  const ok =
    existsSync(binary) &&
    !makefile &&
    !gypi &&
    !objects &&
    install === INSTALL_SCRIPT &&
    pkg.version === "12.11.1";
  return {
    ok,
    version: String(pkg.version),
    install,
    binary: basename(binary),
    makefile,
    gypi,
    objects,
  };
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

  const built = prebuildState();
  process.stdout.write(`better-sqlite3: ${built.version}\n`);
  if (built.ok) {
    pass(
      "prebuild",
      `install=${built.install} binary=${built.binary} makefile=absent config.gypi=absent obj=absent`,
    );
  } else {
    fail(
      "prebuild",
      `install=${built.install || "absent"} binary=${built.binary} makefile=${built.makefile} config.gypi=${built.gypi} obj=${built.objects}`,
    );
  }

  let Database;
  let sqliteVec;
  try {
    Database = (await import("better-sqlite3")).default;
    sqliteVec = await import("sqlite-vec");
  } catch (error) {
    process.stdout.write("sqlite: unknown\n");
    process.stdout.write("sqlite-vec: unknown\n");
    fail("wal", oneLine(error));
    fail("fts5", oneLine(error));
    fail("sqlite-vec-knn", oneLine(error));
    process.exitCode = 1;
    return;
  }

  const require = createRequire(import.meta.url);
  const vecPkg = JSON.parse(
    readFileSync(
      join(dirname(require.resolve("sqlite-vec")), "package.json"),
      "utf8",
    ),
  );
  process.stdout.write(`sqlite-vec: ${String(vecPkg.version)}\n`);

  const dir = mkdtempSync(join(tmpdir(), "cookie-spike-sqlite-"));
  const db = new Database(join(dir, "spike.db"));
  try {
    const version = db.prepare("select sqlite_version() as v").get();
    process.stdout.write(`sqlite: ${version?.v ?? "unknown"}\n`);

    const wal = db.pragma("journal_mode = WAL");
    const journalMode = String(wal?.[0]?.journal_mode ?? "").toLowerCase();
    if (journalMode === "wal") {
      pass("wal", "journal_mode=wal");
    } else {
      fail("wal", `journal_mode=${journalMode || "missing"}`);
    }

    try {
      db.exec("CREATE VIRTUAL TABLE spike_fts USING fts5(text)");
      const insert = db.prepare("INSERT INTO spike_fts(text) VALUES (?)");
      insert.run("ece midterm friday once");
      insert.run("midterm midterm midterm study guide");
      insert.run("packing list for the trip");
      const hits = db
        .prepare(
          "SELECT text, bm25(spike_fts) AS rank FROM spike_fts WHERE spike_fts MATCH ? ORDER BY rank",
        )
        .all("midterm");
      const first = hits[0];
      const second = hits[1];
      const ranked =
        hits.length === 2 &&
        first?.text === "midterm midterm midterm study guide" &&
        second?.text === "ece midterm friday once" &&
        typeof first.rank === "number" &&
        typeof second.rank === "number" &&
        first.rank < second.rank;
      if (ranked) {
        pass(
          "fts5",
          `matches=2 bm25_first=${String(first.rank)} bm25_second=${String(second.rank)}`,
        );
      } else {
        fail("fts5", `rows=${JSON.stringify(hits)}`);
      }
    } catch (error) {
      fail("fts5", oneLine(error));
    }

    try {
      const extension = sqliteVec.getLoadablePath();
      db.loadExtension(extension);
      const loaded = db.prepare("select vec_version() as v").get();
      db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3])");
      const insert = db.prepare(
        "INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)",
      );
      insert.run(1n, new Float32Array([1, 0, 0]));
      insert.run(2n, new Float32Array([0, 1, 0]));
      const rows = db
        .prepare(
          "SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = 2 ORDER BY distance",
        )
        .all(new Float32Array([1, 0, 0]));
      const nearest = rows[0];
      const nearestId = nearest === undefined ? "none" : String(nearest.rowid);
      const distance =
        nearest === undefined ? "none" : String(nearest.distance);
      if (
        rows.length === 2 &&
        nearestId === "1" &&
        Number(nearest.distance) < 1e-5
      ) {
        pass(
          "sqlite-vec-knn",
          `vec_version=${loaded?.v ?? "unknown"} extension=${basename(extension)} nearest=${nearestId} distance=${distance}`,
        );
      } else {
        fail("sqlite-vec-knn", `rows=${JSON.stringify(rows)}`);
      }
    } catch (error) {
      fail("sqlite-vec-knn", oneLine(error));
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  process.exitCode = failed === 0 ? 0 : 1;
}

const openSource = `
import("better-sqlite3").then((mod) => {
  const db = new mod.default(":memory:");
  db.close();
  process.stdout.write("import-ok\\n");
}).catch((error) => {
  process.stderr.write(String(error.stack ?? error) + "\\n");
  process.exitCode = 1;
});
`.trim();

const noisySource = `
import("better-sqlite3").then((mod) => {
  const db = new mod.default(":memory:");
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

  const bare = await run(["-e", openSource], childEnv());
  const quiet = await run([QUIET_FLAG, "-e", openSource], childEnv());
  const noisy = await run([QUIET_FLAG, "-e", noisySource], childEnv());
  const capabilities = await run(
    [QUIET_FLAG, scriptPath],
    childEnv({ [MODE_ENV]: "capabilities" }),
  );

  const bareWarning = bare.stderr.includes(SQLITE_WARNING);
  const warningOk =
    bare.code === 0 &&
    bare.stdout === "import-ok\n" &&
    (bare.stderr === "" || bareWarning) &&
    quiet.code === 0 &&
    quiet.stderr === "" &&
    quiet.stdout === "import-ok\n" &&
    noisy.code === 0 &&
    noisy.stderr === "real-error\n" &&
    capabilities.stderr === "";

  let warningDetail = `bare code=${String(bare.code)} stdout=${JSON.stringify(bare.stdout)} stderr=${JSON.stringify(bare.stderr)} quiet code=${String(quiet.code)} stdout=${JSON.stringify(quiet.stdout)} stderr=${JSON.stringify(quiet.stderr)} noisy code=${String(noisy.code)} stderr=${JSON.stringify(noisy.stderr)} capability stderr=${JSON.stringify(capabilities.stderr)}`;
  if (warningOk && bareWarning) {
    warningDetail =
      "ExperimentalWarning removed by --disable-warning=ExperimentalWarning; capability stderr empty; real stderr line preserved";
  } else if (warningOk) {
    warningDetail =
      "no ExperimentalWarning from better-sqlite3; --disable-warning=ExperimentalWarning keeps stderr empty; real stderr line preserved";
  }

  const warningPassed = report("sqlite-warning", warningOk, warningDetail);
  process.stdout.write(capabilities.stdout);
  if (capabilities.stdout.length > 0 && !capabilities.stdout.endsWith("\n")) {
    process.stdout.write("\n");
  }

  const capabilitiesFailed =
    capabilities.code !== 0 || capabilities.stdout.includes(": FAIL");
  const ok = warningPassed && !capabilitiesFailed;
  report(
    "spike",
    ok,
    ok ? "prebuild wal fts5 sqlite-vec" : "one or more checks failed",
  );
  process.exitCode = ok ? 0 : 1;
}

if (process.env[MODE_ENV] === "capabilities") {
  await runCapabilities();
} else {
  await runSpike();
}
