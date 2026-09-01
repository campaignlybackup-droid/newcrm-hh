import type { Config } from 'tailwindcss';
import { join } from 'node:path';

// Content globs resolve against the process cwd, which is not this
// directory when Next is launched with an explicit project path. Anchor
// them to the config file instead so the JIT always scans the real source.
const src = join(__dirname, 'src', '**', '*.{ts,tsx}');

export default {
  darkMode: 'class',
  content: [src],
  theme: {
    extend: {
      colors: {
        bg:      'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised:  'rgb(var(--raised) / <alpha-value>)',
        border:  'rgb(var(--border) / <alpha-value>)',
        fg:      'rgb(var(--fg) / <alpha-value>)',
        muted:   'rgb(var(--muted) / <alpha-value>)',
        accent:  'rgb(var(--accent) / <alpha-value>)',
        green:   'rgb(var(--green) / <alpha-value>)',
        amber:   'rgb(var(--amber) / <alpha-value>)',
        red:     'rgb(var(--red) / <alpha-value>)',
      },
      fontFamily: { sans: ['var(--font-sans)', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
