import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `next dev <dir>` does not change the process cwd, so a bare
// `tailwindcss: {}` resolves tailwind.config.ts against whatever directory
// the launcher happened to be in — silently falling back to stock Tailwind
// with none of this project's colours. Pin the path explicitly.
const here = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: join(here, 'tailwind.config.ts') },
    autoprefixer: {},
  },
};
