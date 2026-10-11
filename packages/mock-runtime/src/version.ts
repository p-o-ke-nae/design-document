import mockPkg from '../../mock/package.json';

/** Equals the version of @ddv/mock (lint compares the first line of the deployed runtime with it). */
export const RUNTIME_VERSION: string = (mockPkg as { version: string }).version;

export const runtimeBanner = (version = RUNTIME_VERSION) => `// @ddv/mock-runtime ${version}`;
