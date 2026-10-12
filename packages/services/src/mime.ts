const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Extension of the last path segment including the dot (`path.extname` rules), or ''. */
function extname(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

export function mimeOf(p: string): string {
  return MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
}
