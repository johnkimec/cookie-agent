import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installLoopbackGuard,
  LOOPBACK_SELF_TEST_HOST,
  loopbackGuardActive,
  loopbackGuardLine,
  uninstallLoopbackGuard,
} from "./loopback-guard.ts";

const dirs: string[] = [];

afterEach(() => {
  uninstallLoopbackGuard();
  delete process.env.COOKIE_EGRESS_LOG;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loopback guard", () => {
  it("throws on a non-loopback host and allows 127.0.0.1 and ::1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cookie-egress-"));
    dirs.push(dir);
    const log = join(dir, "egress.log");
    writeFileSync(log, "");
    process.env.COOKIE_EGRESS_LOG = log;
    installLoopbackGuard({ COOKIE_LOOPBACK_ONLY: "1" });

    expect(() => {
      connect({ host: "1.1.1.1", port: 9 });
    }).toThrow("egress blocked: 1.1.1.1");
    expect(() => {
      connect({ host: "localhost", port: 9 });
    }).toThrow("egress blocked: localhost");
    expect(readFileSync(log, "utf8")).toContain("egress blocked: 1.1.1.1");

    await expect(refused("127.0.0.1")).resolves.toBe("not-blocked");
    await expect(refused("::1")).resolves.toBe("not-blocked");
  });

  it("does nothing unless COOKIE_LOOPBACK_ONLY is 1", () => {
    installLoopbackGuard({});
    expect(loopbackGuardActive()).toBe(false);
    installLoopbackGuard({ COOKIE_LOOPBACK_ONLY: "1" });
    expect(loopbackGuardActive()).toBe(true);
  });

  it("prints the nonce line only after 192.0.2.1 is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cookie-egress-"));
    dirs.push(dir);
    const log = join(dir, "egress.log");
    writeFileSync(log, "");
    process.env.COOKIE_EGRESS_LOG = log;
    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      installLoopbackGuard({
        COOKIE_LOOPBACK_ONLY: "1",
        COOKIE_EGRESS_LOG: log,
      });
      expect(loopbackGuardActive()).toBe(true);
      expect(lines.join("")).toBe("");
      expect(readFileSync(log, "utf8")).toBe("");
      uninstallLoopbackGuard();
      lines.length = 0;
      installLoopbackGuard({
        COOKIE_LOOPBACK_ONLY: "1",
        COOKIE_LOOPBACK_NONCE: "nonce-9",
        COOKIE_EGRESS_LOG: log,
      });
      expect(lines).toEqual([`${loopbackGuardLine("nonce-9")}\n`]);
      expect(readFileSync(log, "utf8")).toBe("");
      expect(() => {
        connect({ host: LOOPBACK_SELF_TEST_HOST, port: 9 });
      }).toThrow(`egress blocked: ${LOOPBACK_SELF_TEST_HOST}`);
      expect(readFileSync(log, "utf8")).toContain(
        `egress blocked: ${LOOPBACK_SELF_TEST_HOST}`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

function refused(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 1 });
    socket.once("error", (error: Error) => {
      socket.destroy();
      if (error.message.includes("egress blocked")) {
        reject(error);
        return;
      }
      resolve("not-blocked");
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve("not-blocked");
    });
  });
}
