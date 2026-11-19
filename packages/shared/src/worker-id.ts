import { hostname } from 'node:os';

/** Unique id of this worker process, stored on every run it starts. */
export const WORKER_ID = `${hostname()}:${process.pid}`;
