import { createContext, useContext } from 'react';
import type { MockRepoReader } from './mockDocument.ts';
import type { Edition } from './player.ts';

/** Build-time edition (`DDV_EDITION=pages vite build` → Pages, otherwise local). */
export const EDITION: Edition = import.meta.env.DDV_EDITION === 'pages' ? 'pages' : 'local';

/** Where the Pages edition reads mocks from (DD-MOCKSB). Provided by the Pages backend. */
export interface MockSource {
  reader: MockRepoReader;
  /** GitHub file view of a repository path (別タブ). */
  blobUrl?(path: string): string;
}

export const MockSourceContext = createContext<MockSource | null>(null);

export const useMockSource = () => useContext(MockSourceContext);
