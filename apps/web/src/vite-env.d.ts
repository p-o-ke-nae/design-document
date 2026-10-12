/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `pages` = GitHub Pages edition (DD-MOCKSB). Defined by vite.config.ts from the DDV_EDITION environment variable. */
  readonly DDV_EDITION?: 'local' | 'pages';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
