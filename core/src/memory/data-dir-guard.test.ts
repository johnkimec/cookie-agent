import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryDataDir, parseNfsHomeDirectory } from "./path.ts";

const TAIL = [
  "Library",
  "Application Support",
  "com.johnkimec.cookie-agent",
] as const;

const dirs: string[] = [];
const realHome = process.env.HOME;

afterEach(() => {
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dataDir(home: string): string {
  return join(home, ...TAIL);
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("data dir guard", () => {
  it("refuses the account-home data dir when HOME is a temp directory", () => {
    const account = userInfo().homedir;
    const realData = dataDir(account);
    const before = existsSync(realData);
    const spoof = tempDir("cookie-spoof-home-");
    const parent = tempDir("cookie-spoof-link-");
    const link = join(parent, "alias");
    symlinkSync(realData, link);
    process.env.HOME = spoof;
    try {
      expect(() =>
        memoryDataDir({
          NODE_ENV: "TEST",
          HOME: spoof,
          COOKIE_DATA_DIR: realData,
        }),
      ).toThrow(/default data directory/);
      expect(() =>
        memoryDataDir({
          NODE_ENV: "TEST",
          HOME: spoof,
          COOKIE_DATA_DIR: link,
        }),
      ).toThrow(/default data directory/);
    } finally {
      if (realHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = realHome;
      }
    }
    expect(existsSync(realData)).toBe(before);
  });

  it("matches a missing directory by parent inode and relative segments", () => {
    const home = tempDir("cookie-anchor-home-");
    const aliasParent = tempDir("cookie-anchor-alias-");
    const alias = join(aliasParent, "home");
    symlinkSync(home, alias);
    const viaAlias = dataDir(alias);
    const spoof = tempDir("cookie-anchor-spoof-");
    expect(existsSync(dataDir(home))).toBe(false);
    expect(() =>
      memoryDataDir({
        NODE_ENV: "TEST",
        HOME: home,
        COOKIE_DATA_DIR: viaAlias,
      }),
    ).toThrow(/default data directory/);
    expect(() =>
      memoryDataDir({
        NODE_ENV: "TEST",
        HOME: spoof,
        COOKIE_DATA_DIR: join(
          home,
          "Library",
          "Application Support",
          "com.johnkimec.cookie-agent-extra",
        ),
      }),
    ).not.toThrow();
    expect(existsSync(dataDir(home))).toBe(false);
  });

  it("refuses a two-level symlink chain and a path inside the data dir", () => {
    const home = tempDir("cookie-chain-home-");
    const parent = tempDir("cookie-chain-links-");
    const target = dataDir(home);
    const mid = join(parent, "mid");
    const leaf = join(parent, "leaf");
    symlinkSync(target, mid);
    symlinkSync(mid, leaf);
    expect(existsSync(target)).toBe(false);
    expect(() =>
      memoryDataDir({ NODE_ENV: "TEST", HOME: home, COOKIE_DATA_DIR: leaf }),
    ).toThrow(/default data directory/);
    expect(() =>
      memoryDataDir({
        NODE_ENV: "TEST",
        HOME: home,
        COOKIE_DATA_DIR: join(target, "sub"),
      }),
    ).toThrow(/default data directory/);
    const loopA = join(parent, "loop-a");
    const loopB = join(parent, "loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    expect(() =>
      memoryDataDir({ NODE_ENV: "TEST", HOME: home, COOKIE_DATA_DIR: loopA }),
    ).toThrow(/default data directory/);
    expect(existsSync(target)).toBe(false);
  });

  it("reads an NFSHomeDirectory value that dscl wraps onto the next line", () => {
    expect(parseNfsHomeDirectory("NFSHomeDirectory: /Users/ada\n")).toBe(
      "/Users/ada",
    );
    expect(
      parseNfsHomeDirectory("NFSHomeDirectory:\n /Users/ada lovelace\n"),
    ).toBe("/Users/ada lovelace");
    expect(parseNfsHomeDirectory("NFSHomeDirectory:\n")).toBeNull();
    expect(parseNfsHomeDirectory("NFSHomeDirectory:")).toBeNull();
  });

  it("allows a temp data dir under a temp HOME", () => {
    const home = tempDir("cookie-allow-home-");
    const data = tempDir("cookie-allow-data-");
    expect(
      memoryDataDir({ NODE_ENV: "TEST", HOME: home, COOKIE_DATA_DIR: data }),
    ).toBe(data);
  });
});
