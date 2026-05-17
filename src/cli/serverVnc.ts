/** P-30: VNC WebSocket bridge. Pure node:net TCP↔WS RFB proxy — NO websockify,
 *  NO child_process. Server-side RFB auth (DES type 2 / Apple-ARD type 30);
 *  presents type-1 (None) to the browser. Adapted from VM-Test-Matrix
 *  host/proxy/lib/vnc-ws.js (read-only reference — re-authored, typed, DI-shaped).
 *  The DES/ARD crypto is a verbatim port of that file's RFC-6143 / Apple-ARD
 *  implementation; only the target shape + DI surface differ. */
import crypto from "node:crypto";
import net from "node:net";
import type { WebSocket } from "ws";

export interface VncTarget {
  workerId: string;
  host: string;
  vncPort?: number;
  vncPassword?: string;
}

export interface VncWsDeps {
  createConnection?: typeof net.createConnection; // DI
  crypto?: typeof crypto; // DI
  log?: (level: string, line: string) => void;
}

/** RFB DES-ECB: bit-reverse each key byte. In 7-bit ASCII the MSB is always 0;
 *  DES discards 1 bit per byte. Mirroring makes DES discard the always-zero MSB
 *  instead of the significant LSB (the RFB VNC-AUTH quirk). */
export function reverseKeyBits(pw: Buffer): Buffer {
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    const b = pw[i] ?? 0;
    let r = 0;
    for (let bit = 0; bit < 8; bit++) r |= ((b >> bit) & 1) << (7 - bit);
    key[i] = r;
  }
  return key;
}

/** RFB DES-ECB challenge response (RFC-6143 type 2). Two independent 8-byte
 *  ECB blocks over the 16-byte challenge; no PKCS7 padding. */
export function vncDesResponse(password: string, challenge16: Buffer, cryptoLib: typeof crypto = crypto): Buffer {
  const pwBuf = Buffer.alloc(8);
  Buffer.from(String(password || "").slice(0, 8), "binary").copy(pwBuf);
  const key = reverseKeyBits(pwBuf);
  const cipher1 = cryptoLib.createCipheriv("des-ecb", key, null);
  cipher1.setAutoPadding(false);
  const out1 = cipher1.update(challenge16.subarray(0, 8));
  const cipher2 = cryptoLib.createCipheriv("des-ecb", key, null);
  cipher2.setAutoPadding(false);
  const out2 = cipher2.update(challenge16.subarray(8, 16));
  // No .final() — would append a PKCS7 padding block.
  return Buffer.concat([out1, out2]);
}

function leftPadToLen(buf: Buffer, len: number): Buffer {
  if (buf.length === len) return buf;
  if (buf.length > len) return buf.subarray(buf.length - len);
  const out = Buffer.alloc(len);
  buf.copy(out, len - buf.length);
  return out;
}

interface SockReader {
  readN(n: number): Promise<Buffer>;
  drain(): Buffer;
  close(): void;
}

/** Buffered fixed-length reader over a socket. `close()` detaches the data
 *  listener BEFORE the pass-through listener is registered (avoids a leak). */
export function makeReader(sock: net.Socket): SockReader {
  let buf = Buffer.alloc(0);
  const waiters: Array<{ n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];
  function onData(chunk: Buffer): void {
    buf = Buffer.concat([buf, chunk]);
    while (waiters.length > 0 && buf.length >= (waiters[0]?.n ?? 0)) {
      const w = waiters.shift();
      if (!w) break;
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  }
  sock.on("data", onData);
  sock.on("error", (err) => {
    while (waiters.length > 0) waiters.shift()?.reject(err);
  });
  sock.on("close", () => {
    while (waiters.length > 0) waiters.shift()?.reject(new Error("socket closed"));
  });
  return {
    readN(n) {
      if (buf.length >= n) {
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return Promise.resolve(out);
      }
      return new Promise((resolve, reject) => waiters.push({ n, resolve, reject }));
    },
    drain() {
      const out = buf;
      buf = Buffer.alloc(0);
      return out;
    },
    close() {
      sock.removeListener("data", onData);
    },
  };
}

/** Apple ARD (RFB security type 30): DH-1024 key exchange + AES-128-ECB(MD5(
 *  shared)) over user[64]||pass[64]. Verbatim adaptation of vnc-ws.js. */
export async function ardAuthExchange(args: {
  // biome-ignore lint/suspicious/noExplicitAny: DI reader shape (test injects a fake)
  reader: any;
  // biome-ignore lint/suspicious/noExplicitAny: DI socket shape (test injects a fake)
  sock: any;
  // biome-ignore lint/suspicious/noExplicitAny: DI crypto shape (test injects a fake)
  cryptoLib: any;
  username: string;
  password: string;
}): Promise<void> {
  const { reader, sock, cryptoLib, username, password } = args;
  // 1. Read DH parameters from the server.
  const params: Buffer = await reader.readN(4);
  const generator = params.readUInt16BE(0);
  const keyLength = params.readUInt16BE(2);
  if (keyLength <= 0 || keyLength > 1024) {
    throw new Error(`ARD AUTH: implausible keyLength ${keyLength}`);
  }
  const prime: Buffer = await reader.readN(keyLength);
  const serverPublic: Buffer = await reader.readN(keyLength);

  // 2. Generate the client DH keypair with the server-supplied prime + generator.
  const genBuf = Buffer.alloc(2);
  genBuf.writeUInt16BE(generator, 0);
  const dh = cryptoLib.createDiffieHellman(prime, genBuf);
  dh.generateKeys();
  const clientPublic = leftPadToLen(dh.getPublicKey(), keyLength);
  const sharedSecret = leftPadToLen(dh.computeSecret(serverPublic), keyLength);

  // 3. AES-128 key = MD5(sharedSecret).
  const aesKey: Buffer = cryptoLib.createHash("md5").update(sharedSecret).digest();

  // 4. 128-byte credential plaintext: user[64] || pass[64], NUL-padded (cap each
  //    source at 63 bytes so each half ends with a NUL).
  const creds = Buffer.alloc(128, 0);
  const userBuf = Buffer.from(username, "utf8");
  const passBuf = Buffer.from(password, "utf8");
  userBuf.copy(creds, 0, 0, Math.min(userBuf.length, 63));
  passBuf.copy(creds, 64, 0, Math.min(passBuf.length, 63));

  // 5. AES-128-ECB, no padding — input is exactly 128 bytes (two blocks).
  const cipher = cryptoLib.createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(creds), cipher.final()]);

  // 6. Send: encrypted (128) || clientPublic (keyLength).
  sock.write(Buffer.concat([encrypted, clientPublic]));
}

export async function handleVncWs(ws: WebSocket, target: VncTarget, deps: VncWsDeps = {}): Promise<void> {
  const log = deps.log ?? ((lvl, line) => process.stdout.write(`[vnc-ws] ${lvl} ${line}\n`));
  const cryptoLib = deps.crypto ?? crypto;

  // D-6: VNC config (port + password) must be present.
  if (!target.vncPort || !target.vncPassword) {
    log("WARN", `${target.workerId}: no VNC config`);
    try {
      ws.send(JSON.stringify({ type: "error", message: `no VNC config for worker ${target.workerId}` }));
    } catch {
      /* */
    }
    try {
      ws.close(1011);
    } catch {
      /* */
    }
    return;
  }
  const createConnection = deps.createConnection ?? net.createConnection;
  const vncPort = target.vncPort;
  const vncPassword = target.vncPassword;

  let closed = false;
  let phase: "handshake" | "pipe" = "handshake";
  const browserBuf: Buffer[] = [];

  log("INFO", `${target.workerId}: dialing ${target.host}:${vncPort}`);
  const sock = createConnection(vncPort, target.host);

  const cleanupSocket = (): void => {
    if (!sock.destroyed)
      try {
        sock.destroy();
      } catch {
        /* */
      }
  };
  const closeWs = (code: number): void => {
    if (closed) return;
    closed = true;
    try {
      ws.close(code);
    } catch {
      /* */
    }
    cleanupSocket();
  };

  ws.on("message", (data: Buffer) => {
    if (closed) return;
    if (phase === "pipe") {
      try {
        sock.write(data);
      } catch {
        /* */
      }
    } else {
      browserBuf.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
  });
  ws.on("close", () => {
    closed = true;
    cleanupSocket();
  });
  ws.on("error", (err) => {
    log("WARN", `${target.workerId}: ws ${err.message}`);
    closed = true;
    cleanupSocket();
  });

  function readBrowserN(n: number): Promise<Buffer> {
    return new Promise((resolve) => {
      const tryDrain = (): boolean => {
        const total = browserBuf.reduce((a, b) => a + b.length, 0);
        if (total < n) return false;
        const concat = Buffer.concat(browserBuf);
        browserBuf.length = 0;
        const out = concat.subarray(0, n);
        const rest = concat.subarray(n);
        if (rest.length) browserBuf.unshift(rest);
        resolve(out);
        return true;
      };
      if (tryDrain()) return;
      const onMsg = (): void => {
        if (tryDrain()) ws.off("message", onMsg);
      };
      ws.on("message", onMsg);
    });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
  } catch (e) {
    log("ERROR", `${target.workerId}: socket ${e instanceof Error ? e.message : String(e)}`);
    closeWs(1011);
    return;
  }

  const reader = makeReader(sock);

  try {
    // === Phase A: target-side RFB handshake ===
    const tVersion = await reader.readN(12);
    if (!tVersion.toString("binary").startsWith("RFB 003.")) {
      throw new Error(`unexpected RFB version from target: ${tVersion.toString("binary")}`);
    }
    sock.write(Buffer.from("RFB 003.008\n", "binary"));

    const tNumTypes = await reader.readN(1);
    const numTypes = tNumTypes[0] ?? 0;
    if (numTypes === 0) throw new Error("target sent 0 security types (auth disabled or denied)");
    const tTypes = await reader.readN(numTypes);
    // Prefer Apple-ARD (type 30) — universal on post-Tahoe macOS; fall back to
    // DES VNC-AUTH (type 2) for legacy targets.
    let chosenType: 2 | 30;
    if (tTypes.includes(30)) chosenType = 30;
    else if (tTypes.includes(2)) chosenType = 2;
    else throw new Error(`target offers no supported AUTH type (got [${Array.from(tTypes).join(",")}]; need 2 or 30)`);
    sock.write(Buffer.from([chosenType]));

    if (chosenType === 2) {
      const challenge = await reader.readN(16);
      sock.write(vncDesResponse(vncPassword, challenge, cryptoLib));
    } else {
      await ardAuthExchange({ reader, sock, cryptoLib, username: "", password: vncPassword });
    }

    const tResult = await reader.readN(4);
    const status = tResult.readUInt32BE(0);
    if (status !== 0) {
      throw new Error(`target ${chosenType === 30 ? "ARD" : "VNC"} AUTH rejected (SecurityResult=${status})`);
    }

    // === Phase B: browser-side handshake — present type-1 (None) ===
    ws.send(Buffer.from("RFB 003.008\n", "binary"), { binary: true });
    const bVersion = await readBrowserN(12);
    if (!bVersion.toString("binary").startsWith("RFB 003.")) {
      throw new Error(`unexpected RFB version from browser: ${bVersion.toString("binary")}`);
    }
    ws.send(Buffer.from([1, 1]), { binary: true }); // 1 type, type=1 (None)
    const bTypeSel = await readBrowserN(1);
    if (bTypeSel[0] !== 1) throw new Error(`browser selected unexpected type ${bTypeSel[0]}`);
    ws.send(Buffer.from([0, 0, 0, 0]), { binary: true }); // SecurityResult OK

    // === Bidirectional pass-through ===
    phase = "pipe";
    const leftover = reader.drain();
    reader.close(); // detach the reader listener BEFORE the pipe listener
    if (leftover.length)
      try {
        ws.send(leftover, { binary: true });
      } catch {
        /* */
      }

    sock.on("data", (chunk: Buffer) => {
      if (closed) return;
      try {
        ws.send(chunk, { binary: true });
      } catch {
        /* */
      }
    });
    sock.on("close", () => closeWs(1000));
    sock.on("error", (err) => {
      log("ERROR", `${target.workerId}: socket ${err.message}`);
      closeWs(1011);
    });

    if (browserBuf.length > 0) {
      const rest = Buffer.concat(browserBuf);
      browserBuf.length = 0;
      try {
        sock.write(rest);
      } catch {
        /* */
      }
    }
  } catch (err) {
    log("ERROR", `${target.workerId}: handshake ${err instanceof Error ? err.message : String(err)}`);
    closeWs(1011);
  }
}
