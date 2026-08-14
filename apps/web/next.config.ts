import type { NextConfig } from 'next';

const config: NextConfig = {
  /**
   * `@untitled/schema` is published as TypeScript source rather than built
   * output — there is no build step in the workspace and nothing wants one — so
   * Next has to compile it the same way it compiles this app.
   */
  transpilePackages: ['@untitled/schema'],
};

export default config;
