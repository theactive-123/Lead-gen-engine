import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // @lead/shared is TypeScript source in the monorepo; the dashboard imports only its pure segment-filter module.
  transpilePackages: ['@lead/shared'],
  serverExternalPackages: ['pg', 'pg-boss'],
  // Do-not-contact lists are uploaded as CSV (a 100k-line file is a few MB).
  experimental: { serverActions: { bodySizeLimit: '20mb' } },
};
export default config;
