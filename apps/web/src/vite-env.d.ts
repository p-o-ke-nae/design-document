/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `pages` = GitHub Pages edition (DD-MOCKSB). Defined by vite.config.ts from the DDV_EDITION environment variable. */
  readonly DDV_EDITION?: 'local' | 'pages';
  /** pages.config.json validated at build time (pat.md). `null` in the local edition. */
  readonly DDV_PAGES_CONFIG?: import('@ddv/core').PagesConfig | null;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
