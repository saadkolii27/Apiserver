import { logger } from "./logger";
import os from "os";

export interface QueueTask<T = unknown> {
  id: string;
  domain: string;
  priority: number;
  data: T;
  addedAt: number;
}

interface QueueOptions {
  maxConcurrency?: number;
  maxBrowserConcurrency?: number;
  domainRateLimitMs?: number;
  batchSize?: number;
}

type TaskExecutor<T> = (task: QueueTask<T>) => Promise<void>;
type DedupeKeyFn<T> = (task: QueueTask<T>) => string;

export class MonitorQueue<T = unknown> {
  private pending: QueueTask<T>[] = [];
  private running = 0;
  private runningBrowser = 0;
  private maxConcurrency: number;
  private maxBrowserConcurrency: number;
  private domainRateLimitMs: number;
  private lastDomainAccess = new Map<string, number>();
  private executor: TaskExecutor<T> | null = null;
  private processing = false;
  private isBrowserTask: ((task: QueueTask<T>) => boolean) | null = null;
  private dedupeKeyFn: DedupeKeyFn<T> | null = null;
  private activeKeys = new Set<string>();
  private pendingKeys = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: QueueOptions = {}) {
    const cpuCount = os.cpus().length;
    this.maxConcurrency = opts.maxConcurrency ?? Math.max(cpuCount * 2, 4);
    this.maxBrowserConcurrency = opts.maxBrowserConcurrency ?? Math.max(Math.floor(cpuCount / 2), 1);
    this.domainRateLimitMs = opts.domainRateLimitMs ?? 2000;
  }

  setExecutor(fn: TaskExecutor<T>): void {
    this.executor = fn;
  }

  setIsBrowserTask(fn: (task: QueueTask<T>) => boolean): void {
    this.isBrowserTask = fn;
  }

  setDedupeKey(fn: DedupeKeyFn<T>): void {
    this.dedupeKeyFn = fn;
  }

  enqueue(task: QueueTask<T>): void {
    if (this.isDuplicate(task)) return;
    this.pending.push(task);
    this.trackPending(task);
    this.pending.sort((a, b) => a.priority - b.priority);
    this.process();
  }

  enqueueBatch(tasks: QueueTask<T>[]): void {
    let added = 0;
    for (const t of tasks) {
      if (this.isDuplicate(t)) continue;
      this.pending.push(t);
      this.trackPending(t);
      added++;
    }
    if (added > 0) {
      this.pending.sort((a, b) => a.priority - b.priority);
      this.process();
    }
  }

  get stats() {
    return {
      pending: this.pending.length,
      running: this.running,
      runningBrowser: this.runningBrowser,
      maxConcurrency: this.maxConcurrency,
      maxBrowserConcurrency: this.maxBrowserConcurrency,
    };
  }

  private isDuplicate(task: QueueTask<T>): boolean {
    if (!this.dedupeKeyFn) return false;
    const key = this.dedupeKeyFn(task);
    return this.activeKeys.has(key) || this.pendingKeys.has(key);
  }

  private trackPending(task: QueueTask<T>): void {
    if (!this.dedupeKeyFn) return;
    this.pendingKeys.add(this.dedupeKeyFn(task));
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      let madeProgress = true;
      while (this.pending.length > 0 && this.running < this.maxConcurrency && madeProgress) {
        madeProgress = false;

        for (let i = 0; i < this.pending.length; i++) {
          if (this.running >= this.maxConcurrency) break;

          const task = this.pending[i];
          const isBrowser = this.isBrowserTask?.(task) ?? false;

          if (isBrowser && this.runningBrowser >= this.maxBrowserConcurrency) {
            continue;
          }

          const now = Date.now();
          const lastAccess = this.lastDomainAccess.get(task.domain) ?? 0;
          if (now - lastAccess < this.domainRateLimitMs) {
            continue;
          }

          this.pending.splice(i, 1);
          i--;

          if (this.dedupeKeyFn) {
            const key = this.dedupeKeyFn(task);
            this.pendingKeys.delete(key);
            this.activeKeys.add(key);
          }

          this.running++;
          if (isBrowser) this.runningBrowser++;
          this.lastDomainAccess.set(task.domain, Date.now());
          madeProgress = true;

          this.executeTask(task, isBrowser).catch((err) => {
            logger.error({ err, taskId: task.id }, "Queue task failed");
          });
        }
      }

      if (this.pending.length > 0) {
        this.scheduleRetry();
      }
    } finally {
      this.processing = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.process();
    }, this.domainRateLimitMs);
  }

  private async executeTask(task: QueueTask<T>, isBrowser: boolean): Promise<void> {
    try {
      if (this.executor) {
        await this.executor(task);
      }
    } catch (err) {
      logger.error({ err, taskId: task.id }, "Queue task execution error");
    } finally {
      this.running--;
      if (isBrowser) this.runningBrowser--;
      if (this.dedupeKeyFn) {
        this.activeKeys.delete(this.dedupeKeyFn(task));
      }
      this.process();
    }
  }
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
