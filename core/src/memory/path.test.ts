import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMemoryDataDir,
  MEMORY_DB_FILENAME,
  memoryDatabasePath,
  memoryDataDir,
} from "./path.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory data directory", () => {
  it("returns the product default outside a test env", () => {
    const db = join(defaultMemoryDataDir(), MEMORY_DB_FILENAME);
    const before = existsSync(db);
    expect(memoryDataDir({})).toBe(defaultMemoryDataDir());
    expect(memoryDatabasePath({})).toBe(db);
    expect(existsSync(db)).toBe(before);
  });

  it("treats an empty VITEST as unset", () => {
    expect(memoryDataDir({ VITEST: "" })).toBe(defaultMemoryDataDir());
  });

  it("refuses the default directory when VITEST is set", () => {
    const db = join(defaultMemoryDataDir(), MEMORY_DB_FILENAME);
    const before = existsSync(db);
    expect(() => memoryDataDir({ VITEST: "true" })).toThrow(
      /default data directory/,
    );
    expect(() => memoryDatabasePath({ VITEST: "1" })).toThrow(
      /COOKIE_DATA_DIR/,
    );
    expect(existsSync(db)).toBe(before);
  });

  it("refuses the default directory when NODE_ENV is test", () => {
    expect(() => memoryDataDir({ NODE_ENV: "test" })).toThrow(
      /default data directory/,
    );
    expect(() => memoryDataDir({ NODE_ENV: "TEST" })).toThrow(
      /default data directory/,
    );
    expect(() =>
      memoryDataDir({ NODE_ENV: "test", COOKIE_DATA_DIR: "" }),
    ).toThrow(/temporary directory/);
  });

  it("refuses COOKIE_DATA_DIR pointed at the default directory", () => {
    const dir = defaultMemoryDataDir();
    expect(() =>
      memoryDataDir({ VITEST: "true", COOKIE_DATA_DIR: dir }),
    ).toThrow(/default data directory/);
    expect(() =>
      memoryDataDir({ NODE_ENV: "test", COOKIE_DATA_DIR: `${dir}/` }),
    ).toThrow(/default data directory/);
  });

  it("refuses a symlink whose real path is the default directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "cookie-data-link-"));
    dirs.push(parent);
    const link = join(parent, "data");
    symlinkSync(defaultMemoryDataDir(), link);
    expect(() =>
      memoryDataDir({ VITEST: "true", COOKIE_DATA_DIR: link }),
    ).toThrow(/default data directory/);
  });

  it("refuses a symlink alias when the default directory exists", () => {
    const dir = defaultMemoryDataDir();
    const created = !existsSync(dir);
    if (created) {
      mkdirSync(dir, { recursive: true });
    }
    const parent = mkdtempSync(join(tmpdir(), "cookie-data-alias-"));
    dirs.push(parent);
    const link = join(parent, "alias");
    symlinkSync(dir, link);
    try {
      expect(() =>
        memoryDataDir({ NODE_ENV: "TEST", COOKIE_DATA_DIR: link }),
      ).toThrow(/default data directory/);
    } finally {
      if (created) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("allows a temporary COOKIE_DATA_DIR under test", () => {
    const dir = mkdtempSync(join(tmpdir(), "cookie-data-ok-"));
    dirs.push(dir);
    expect(
      memoryDataDir({ VITEST: "true", NODE_ENV: "test", COOKIE_DATA_DIR: dir }),
    ).toBe(dir);
    expect(memoryDatabasePath({ NODE_ENV: "test", COOKIE_DATA_DIR: dir })).toBe(
      join(dir, MEMORY_DB_FILENAME),
    );
  });
});
