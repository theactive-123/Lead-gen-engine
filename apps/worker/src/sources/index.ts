import { commoncrawl } from './commoncrawl.js';
import { ct } from './ct/source.js';
import { tranco } from './tranco.js';
import type { Source } from './types.js';
import { whoisds } from './whoisds.js';

/** Registry of all source plugins. Add a new source here + a row in the `sources` table. */
export const SOURCES: Record<string, Source<any>> = {
  [tranco.key]: tranco,
  [whoisds.key]: whoisds,
  [ct.key]: ct,
  [commoncrawl.key]: commoncrawl,
};
