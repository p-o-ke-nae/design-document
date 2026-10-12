/** Clock, randomness and hashing given to the services (tests pass fixed values). */
export interface Clock {
  now(): number;
}

export interface Random {
  bytes(n: number): Uint8Array;
}

export interface ServiceEnv {
  clock: Clock;
  random: Random;
  newId(): string;
  /** SHA-256 of the UTF-8 text (or bytes), hex, first 16 characters. */
  hash(text: string | Uint8Array): Promise<string>;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex16(text: string | Uint8Array): Promise<string> {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return hex(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)).slice(0, 16);
}

export const systemEnv: ServiceEnv = {
  clock: { now: () => Date.now() },
  random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
  newId: () => crypto.randomUUID(),
  hash: sha256Hex16,
};
