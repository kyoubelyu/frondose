import { readlink, unlink } from "node:fs/promises";
import { join } from "node:path";

const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

export async function clearStaleSingletonLocks(
  profileDir: string,
  killFn: (pid: number, signal: 0) => void = process.kill,
): Promise<void> {
  let target: string;
  try {
    target = await readlink(join(profileDir, "SingletonLock"));
  } catch {
    return;
  }

  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    killFn(pid, 0);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") return;
  }

  await Promise.all(
    SINGLETON_FILES.map(async (file) => {
      try {
        await unlink(join(profileDir, file));
      } catch {
        // best-effort
      }
    }),
  );
}
