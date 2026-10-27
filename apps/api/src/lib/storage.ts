import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Object storage abstraction. The local-disk implementation is used for
 * development and single-node installs; an S3-compatible implementation can
 * be added behind the same interface (see docs/deployment.md).
 */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  publicUrl(key: string): string;
}

const KEY_RE = /^[a-zA-Z0-9/_-]+\.(png|jpg|gif|webp)$/;

export class LocalStorage implements Storage {
  private root: string;
  constructor(dir: string, private baseUrl: string) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    if (!KEY_RE.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx' }).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err; // content-addressed: identical file already stored
    });
  }
  async get(key: string) {
    try {
      const p = this.path(key);
      await stat(p);
      return await readFile(p);
    } catch {
      return null;
    }
  }
  publicUrl(key: string) {
    return `${this.baseUrl.replace(/\/$/, '')}/assets/${key}`;
  }
}
