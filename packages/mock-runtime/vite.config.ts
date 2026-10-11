import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const version = (JSON.parse(readFileSync(r('../mock/package.json'), 'utf8')) as { version: string }).version;

// First line must be `// @ddv/mock-runtime <version>` (compared by ddv-lint / ddv mock init).
const banner = (): Plugin => ({
  name: 'ddv-runtime-banner',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') chunk.code = `// @ddv/mock-runtime ${version}\n${chunk.code}`;
  },
});

export default defineConfig({
  root: r('.'),
  publicDir: false,
  resolve: {
    alias: {
      '@ddv/mock/tune-patch': r('../mock/src/tune-patch.ts'),
      '@ddv/mock/step': r('../mock/src/step.ts'),
    },
  },
  plugins: [banner()],
  build: {
    outDir: r('dist'),
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    lib: {
      entry: r('src/main.ts'),
      formats: ['es'],
      fileName: () => 'mock-runtime.js',
    },
    rollupOptions: { external: [] },
  },
});