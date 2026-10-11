/** Values that reveal `token` when printed: the token itself and the base64 forms used in git's Basic auth header. */
export function secretForms(token: string): string[] {
  if (!token) return [];
  return [token, Buffer.from(`x-access-token:${token}`).toString('base64'), Buffer.from(token).toString('base64')];
}

/** Replaces every occurrence of the tokens (and their base64 forms) with `***`. */
export function redact(text: string, tokens: (string | undefined | null)[]): string {
  let out = text;
  for (const t of tokens) {
    for (const s of secretForms(t ?? '')) out = out.split(s).join('***');
  }
  return out;
}
