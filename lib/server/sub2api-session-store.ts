import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type Sub2ApiSession = {
  provider: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  expiresAt: number;
};

// One Node host, persistent local disk. Provider tokens never reach browser JS.
// A file lock also serializes token rotation across Next.js workers on this host.
function directory(): string {
  return path.resolve(process.env.SUB2API_SESSION_DIR || path.join(process.cwd(), ".data", "sub2api-sessions"));
}

function encryptionKey(): Buffer {
  const secret = process.env.ACCOUNT_GATE_SECRET || "";
  if (secret.trim().length < 32) throw new Error("请配置至少 32 位 ACCOUNT_GATE_SECRET。");
  return createHash("sha256").update(`xunxin-sub2api-v1:${secret.trim()}`).digest();
}

function filename(id: string): string {
  if (!/^s2a_[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("会话无效，请重新登录。");
  return path.join(directory(), `${id}.json`);
}

export function newSub2ApiSessionId(): string {
  return `s2a_${randomBytes(32).toString("base64url")}`;
}

export function assertSub2ApiSessionSecret(): void { encryptionKey(); }

export async function readSub2ApiSession(id: string): Promise<Sub2ApiSession | null> {
  if (!/^s2a_[A-Za-z0-9_-]{43}$/.test(id)) return null;
  try {
    const payload = await readFile(filename(id), "utf8");
    if (payload.length > 32768) return null;
    const [version, iv, tag, body, ...rest] = payload.split(".");
    if (version !== "v1" || rest.length || !iv || !tag || !body) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const session = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8")) as Sub2ApiSession;
    if (typeof session.accessToken !== "string" || !session.accessToken || typeof session.refreshToken !== "string"
      || typeof session.provider !== "string" || !Number.isFinite(session.accessExpiresAt)
      || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
    return session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Invalid ciphertext/changed secret invalidates the session, never bypasses auth.
    if (!(error as NodeJS.ErrnoException).code || /ERR_OSSL|ERR_CRYPTO/.test((error as NodeJS.ErrnoException).code || "")) return null;
    throw error;
  }
}

export async function writeSub2ApiSession(id: string, session: Sub2ApiSession): Promise<void> {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  const payload = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  const target = filename(id);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function deleteSub2ApiSession(id: string): Promise<void> {
  if (!/^s2a_[A-Za-z0-9_-]{43}$/.test(id)) return;
  await unlink(filename(id)).catch(error => { if (error.code !== "ENOENT") throw error; });
}

export async function withSub2ApiSessionLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const lockPath = `${filename(id)}.lock`;
  const deadline = Date.now() + 12000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) { await handle.close(); await unlink(lockPath).catch(() => undefined); throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Recover only a demonstrably dead local worker's lock, never a slow request.
      let recovery;
      try {
        // Only one worker may recover an orphan, so a second recovery cannot
        // accidentally unlink a new lock acquired immediately after the old one.
        recovery = await open(`${lockPath}.recover`, "wx", 0o600);
        if (Date.now() - (await stat(lockPath)).mtimeMs > 30000) {
          const owner = JSON.parse(await readFile(lockPath, "utf8"));
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === "ESRCH") await unlink(lockPath);
            }
          }
        }
      } catch { /* Another worker may already have released/recovered the lock. */ }
      finally { if (recovery) { await recovery.close(); await unlink(`${lockPath}.recover`).catch(() => undefined); } }
      if (Date.now() >= deadline) throw new Error("账号会话正在续期，请稍后重试。");
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  }
  try { return await operation(); }
  finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
