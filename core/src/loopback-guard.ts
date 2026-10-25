/**
 * Refuse a TCP connect that is not loopback.
 *
 * Installed only when `COOKIE_LOOPBACK_ONLY=1`. Production leaves the
 * variable unset. The eval sets it on the core child. A blocked host is
 * written to stderr and, when `COOKIE_EGRESS_LOG` is set, appended there
 * so a caught connect error still fails the run.
 */

import { appendFileSync } from "node:fs";
import { Socket } from "node:net";

/** TEST-NET-1. The guard must refuse this host before it reports itself. */
export const LOOPBACK_SELF_TEST_HOST = "192.0.2.1";

/**
 * Exact stderr line the eval requires.
 * The nonce comes from `COOKIE_LOOPBACK_NONCE`, which the runner sets.
 */
export function loopbackGuardLine(nonce: string): string {
  return `cookie-core: loopback guard active ${nonce}`;
}

type Connect = Socket["connect"];

let original: Connect | null = null;
let probing = false;

export function installLoopbackGuard(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.COOKIE_LOOPBACK_ONLY !== "1" || original !== null) {
    return;
  }
  original = Socket.prototype.connect;
  const saved = original;
  Socket.prototype.connect = function connect(
    this: Socket,
    ...args: Parameters<Connect>
  ): Socket {
    const host = connectHost(args);
    if (host !== null && !isLoopbackHost(host)) {
      if (!probing) {
        noteBlocked(host);
      }
      throw new Error(`egress blocked: ${host}`);
    }
    return saved.apply(this, args) as Socket;
  } as Connect;
  if (!selfTestRefused()) {
    return;
  }
  const nonce = env.COOKIE_LOOPBACK_NONCE;
  if (typeof nonce !== "string" || nonce === "" || /[\r\n]/.test(nonce)) {
    return;
  }
  process.stderr.write(`${loopbackGuardLine(nonce)}\n`);
}

function selfTestRefused(): boolean {
  probing = true;
  try {
    const socket = new Socket();
    try {
      socket.connect({ host: LOOPBACK_SELF_TEST_HOST, port: 9 });
      socket.destroy();
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return message === `egress blocked: ${LOOPBACK_SELF_TEST_HOST}`;
    }
  } finally {
    probing = false;
  }
}

export function loopbackGuardActive(): boolean {
  return original !== null;
}

export function uninstallLoopbackGuard(): void {
  if (original === null) {
    return;
  }
  Socket.prototype.connect = original;
  original = null;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "127.0.0.1" || bare === "::1";
}

function noteBlocked(host: string): void {
  const message = `egress blocked: ${host}`;
  process.stderr.write(`cookie-core: ${message}\n`);
  const file = process.env.COOKIE_EGRESS_LOG;
  if (file === undefined || file === "") {
    return;
  }
  try {
    appendFileSync(file, `${message}\n`);
  } catch {
    // The throw still fails the connect. The log is a second signal.
  }
}

function connectHost(args: readonly unknown[]): string | null {
  const first = args[0];
  // Node's `net.connect` calls `socket.connect([options, listener])`.
  if (Array.isArray(first)) {
    return connectHost(first);
  }
  if (typeof first === "number") {
    const second = args[1];
    return typeof second === "string" ? second : null;
  }
  if (typeof first !== "object" || first === null) {
    return null;
  }
  const options = first as { host?: unknown; hostname?: unknown };
  const host = options.host ?? options.hostname;
  return typeof host === "string" && host.length > 0 ? host : null;
}
