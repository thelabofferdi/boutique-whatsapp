import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ShopState, StateStore } from "./core.ts";

/** Stockage fichier du palier 2 : le stock et les commandes survivent aux redémarrages. */
export class FileStore implements StateStore {
  path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<ShopState | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as ShopState;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async save(state: ShopState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
