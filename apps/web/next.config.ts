import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  serverExternalPackages: ['pg'],
};
export default config;
