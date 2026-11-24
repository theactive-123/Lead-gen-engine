import { Worker } from 'node:worker_threads';
import type { Detection, TechEngine } from './engine.js';

type Page = Parameters<TechEngine['analyze']>[0];

/**
 * Small pool of worker threads, each with its own TechEngine, so detection uses several CPU cores.
 * The detection code is identical to the single-thread path; only throughput changes.
 */
export class TechPool {
  private workers: { w: Worker; busy: boolean }[] = [];
  private queue: { id: number; page: Page }[] = [];
  private pending = new Map<number, { resolve: (d: Detection[]) => void; reject: (e: Error) => void; w?: Worker }>();
  private nextId = 0;

  constructor(size: number) {
    // Running from TypeScript source: threads need the tsx loader. Reuse the parent's flags when it
    // already has them (the worker runs under tsx), otherwise register tsx explicitly (e.g. under vitest).
    const fromTs = import.meta.url.endsWith('.ts');
    const url = new URL(`./thread${fromTs ? '.ts' : '.js'}`, import.meta.url);
    const hasTsx = process.execArgv.some((a) => a.includes('tsx'));
    const execArgv = fromTs && !hasTsx ? [...process.execArgv, '--import', import.meta.resolve('tsx')] : process.execArgv;
    for (let i = 0; i < size; i++) {
      const w = new Worker(url, { execArgv });
      const slot = { w, busy: false };
      w.on('message', (m: { id: number; result?: Detection[]; error?: string }) => {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        slot.busy = false;
        if (m.error) p?.reject(new Error(m.error));
        else p?.resolve(m.result ?? []);
        this.pump();
      });
      w.on('error', (err) => {
        for (const [id, p] of this.pending) if (p.w === w) { p.reject(err); this.pending.delete(id); }
      });
      this.workers.push(slot);
    }
  }

  analyze(page: Page): Promise<Detection[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, page });
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const job = this.queue.shift()!;
      slot.busy = true;
      this.pending.get(job.id)!.w = slot.w;
      slot.w.postMessage(job);
    }
  }

  async close() {
    await Promise.all(this.workers.map((s) => s.w.terminate()));
  }
}
