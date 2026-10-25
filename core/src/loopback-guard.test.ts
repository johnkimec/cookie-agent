import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installLoopbackGuard,
  loopbackGuardActive,
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
