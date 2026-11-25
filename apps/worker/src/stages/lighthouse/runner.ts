import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { summarizeLhr, type LhSummary } from './core.js';

/**
 * One Lighthouse run in its own process (forked by stage.ts), with its own Chrome.
 * Why a process per run: Lighthouse keeps global timing state, so two runs in one Node process break
 * each other ("performance mark has not been set"); its docs say to use separate processes for
 * parallel runs. A process can also be killed outright when a page hangs.
 *
 * Input (message): { url, chromePath?, flags[], timeoutMs }.
 * Output (message): { ok: true, summary, scriptUrls } or { ok: false, error }. Then the process exits.
 */
export interface RunnerInput { url: string; chromePath?: string; flags: string[]; timeoutMs: number }
export type RunnerOutput = { ok: true; summary: LhSummary; scriptUrls: string[] } | { ok: false; error: string };

let chrome: chromeLauncher.LaunchedChrome | undefined;

function finish(out: RunnerOutput): void {
  try {
    chrome?.kill();
  } catch {
    /* already gone */
  }
  process.send?.(out, () => process.exit(0));
}

process.once('message', async (input: RunnerInput) => {
  const timer = setTimeout(() => finish({ ok: false, error: 'lighthouse_timeout' }), input.timeoutMs);
  try {
    chrome = await chromeLauncher.launch({ chromePath: input.chromePath, chromeFlags: input.flags, logLevel: 'silent' });
    const result = await lighthouse(input.url, {
      port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });
    const lhr = result?.lhr;
    if (!lhr) throw new Error('lighthouse_no_result');
    if (lhr.runtimeError?.code) throw new Error(`lighthouse_${lhr.runtimeError.code}`);
    clearTimeout(timer);
    finish({ ok: true, ...summarizeLhr(lhr) });
  } catch (e) {
    clearTimeout(timer);
    finish({ ok: false, error: (e as Error).message.slice(0, 200) });
  }
});
