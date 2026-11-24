import { parentPort } from 'node:worker_threads';
import { TechEngine } from './engine.js';

/** Worker-thread entry: holds its own engine and analyses pages sent by the pool. */
const engine = new TechEngine();
parentPort!.on('message', (msg: { id: number; page: Parameters<TechEngine['analyze']>[0] }) => {
  try {
    parentPort!.postMessage({ id: msg.id, result: engine.analyze(msg.page) });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: String((err as Error).message ?? err) });
  }
});
