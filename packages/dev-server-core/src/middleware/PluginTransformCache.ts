import LRUCache from 'lru-cache';
import { FSWatcher } from 'chokidar';
import fs from 'fs';
import { promisify } from 'util';
import { RequestCancelledError } from '../utils';

const fsStat = promisify(fs.stat);

async function fileExists(filePath: string) {
  try {
    const stat = await fsStat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

interface CacheEntry {
  body: string;
  headers: Record<string, string>;
  filePath: string;
}

export class PluginTransformCache {
  private cacheKeysPerFilePath = new Map<string, Set<string>>();

  private lruCache: LRUCache<string, CacheEntry>;

  constructor(private fileWatcher: FSWatcher, private rootDir: string) {
    this.lruCache = new LRUCache({
      length: (e, key) => e.body.length + (key ? key.length : 0),
      max: 52428800,
      noDisposeOnSet: true,
      dispose: cacheKey => {
        // remove file path -> url mapping when we are no longer caching it
        for (const [filePath, cacheKeysForFilePath] of this.cacheKeysPerFilePath.entries()) {
          if (cacheKeysForFilePath.has(cacheKey)) {
            this.cacheKeysPerFilePath.delete(filePath);
            return;
          }
        }
      },
    });

    // remove file from cache on change
    fileWatcher.addListener('change', (filePath: string) => {
      const cacheKeys = this.cacheKeysPerFilePath.get(filePath);
      if (cacheKeys) {
        for (const cacheKey of cacheKeys) {
          this.lruCache.del(cacheKey);
        }
      }
    });
  }

  async get(cacheKey: string) {
    return this.lruCache.get(cacheKey);
  }

  async set(filePath: string, body: string, headers: Record<string, string>, cacheKey: string) {
    try {
      if (!(await fileExists(filePath))) {
        // only cache files on the file system
        return;
      }

      if (typeof body === 'string') {
        let cacheKeysForFilePath = this.cacheKeysPerFilePath.get(filePath);
        if (!cacheKeysForFilePath) {
          cacheKeysForFilePath = new Set();
          this.cacheKeysPerFilePath.set(filePath, cacheKeysForFilePath);
        }
        cacheKeysForFilePath.add(cacheKey);

        this.lruCache.set(cacheKey, { body, headers, filePath });
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        // no need to do anything if the request was cancelled
        return;
      }
      throw error;
    }
  }
}
