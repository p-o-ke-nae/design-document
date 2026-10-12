function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Values that reveal `token` when printed: the token itself and the base64 forms used in git's Basic auth header. */
export function secretForms(token: string): string[] {
  if (!token) return [];
  return [token, base64(`x-access-token:${token}`), base64(token)];
}

/** Replaces every occurrence of the tokens (and their base64 forms) with `***`. */
export function redact(text: string, tokens: (string | undefined | null)[]): string {
  let out = text;
  for (const t of tokens) {
    for (const s of secretForms(t ?? '')) out = out.split(s).join('***');
  }
  return out;
}
