/**
 * Receipt persistence. The default store writes one JSON file per receipt,
 * readable only by the current user, plus `latest.json`. Writes are atomic
 * (temp file + rename) so a crash never leaves a half-written receipt.
 */
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Receipt } from "@agentproof/core";

export interface ReceiptStore {
  save(receipt: Receipt): Promise<string | void>;
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly receipts: Receipt[] = [];
  async save(receipt: Receipt): Promise<void> {
    this.receipts.push(receipt);
  }
}

const safeName = (id: string) => {
  const name = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return name === "latest" || name.startsWith(".") ? `run-${name}` : name;
};

/** Write a file atomically with owner-only permissions. */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export class FileReceiptStore implements ReceiptStore {
  readonly dir: string;
  constructor(dir = "agentproof-reports") {
    this.dir = dir;
  }

  /** Persist a receipt; returns its path. */
  async save(receipt: Receipt): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const json = `${JSON.stringify(receipt, null, 2)}\n`;
    const path = join(this.dir, `${safeName(receipt.run_id)}.json`);
    await writePrivateFile(path, json);
    await writePrivateFile(join(this.dir, "latest.json"), json);
    return path;
  }

  async load(path: string): Promise<Receipt> {
    return JSON.parse(await readFile(path, "utf8")) as Receipt;
  }

  /** Delete receipts and reports older than `days`. Returns the removed file names. */
  async prune(days: number, now: Date = new Date()): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const cutoff = now.getTime() - days * 86_400_000;
    const removed: string[] = [];
    for (const name of names) {
      if (!/\.(json|html)$/.test(name) || name === "latest.json" || name === "latest.html") continue;
      const path = join(this.dir, name);
      if ((await stat(path)).mtimeMs < cutoff) {
        await unlink(path);
        removed.push(name);
      }
    }
    return removed;
  }
}
