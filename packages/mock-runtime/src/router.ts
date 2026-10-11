import { evalCondition } from './expr.ts';
import type { MemoryDb, Row, TableDef } from './db.ts';

export type Op = 'list' | 'get' | 'insert' | 'update' | 'delete';
const OPS: Op[] = ['list', 'get', 'insert', 'update', 'delete'];

export interface WhenSpec {
  if: string;
  status: number;
  body?: unknown;
}

export interface RouteSpec {
  method: string;
  path: string;
  op?: Op;
  table?: string;
  set?: Row;
  status?: number;
  body?: unknown;
  when: WhenSpec[];
}

export interface ApiSpec {
  base: string;
  tables: TableDef[];
  routes: RouteSpec[];
}

export interface MockRequest {
  method: string;
  /** Path below `base` (e.g. `/orders/1`). */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status: number;
  body?: unknown;
}

/** JS handler (`mock.route`). A return value without `status` is sent as 200 JSON. */
export type RouteHandler = (req: MockRequest, db: MemoryDb) => unknown;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validates parsed api.yaml. Invalid entries are skipped and reported in `errors`. */
export function parseApiSpec(raw: unknown): { spec: ApiSpec; errors: string[] } {
  const errors: string[] = [];
  const spec: ApiSpec = { base: '/api', tables: [], routes: [] };
  if (raw === null || raw === undefined) return { spec, errors };
  if (!isObj(raw)) return { spec, errors: ['api.yaml の形式が正しくありません（オブジェクトではありません）'] };
  if (raw.base !== undefined) {
    if (typeof raw.base === 'string' && raw.base.startsWith('/')) spec.base = raw.base.replace(/\/+$/, '') || '/';
    else errors.push('api.yaml: base は「/」で始まる文字列にしてください');
  }
  const tables = raw.tables ?? [];
  if (!Array.isArray(tables)) errors.push('api.yaml: tables は配列にしてください');
  else
    tables.forEach((t, i) => {
      if (typeof t === 'string' && t) spec.tables.push({ name: t, key: 'id' });
      else if (isObj(t) && typeof t.name === 'string' && t.name) spec.tables.push({ name: t.name, key: typeof t.key === 'string' && t.key ? t.key : 'id' });
      else errors.push(`api.yaml: tables[${i}] は表名か { name, key } にしてください`);
    });
  const routes = raw.routes ?? [];
  if (!Array.isArray(routes)) errors.push('api.yaml: routes は配列にしてください');
  else
    routes.forEach((r, i) => {
      const at = `api.yaml: routes[${i}]`;
      if (!isObj(r)) return errors.push(`${at} はオブジェクトにしてください`);
      if (typeof r.method !== 'string' || typeof r.path !== 'string' || !r.path.startsWith('/')) return errors.push(`${at} には method と「/」で始まる path が必要です`);
      if (r.op !== undefined && !OPS.includes(r.op as Op)) return errors.push(`${at}: op は ${OPS.join(' / ')} のいずれかにしてください`);
      if (r.op !== undefined && typeof r.table !== 'string') return errors.push(`${at}: op には table が必要です`);
      if (r.set !== undefined && !isObj(r.set)) return errors.push(`${at}: set はオブジェクトにしてください`);
      if (r.status !== undefined && typeof r.status !== 'number') return errors.push(`${at}: status は数値にしてください`);
      const when: WhenSpec[] = [];
      for (const [j, w] of (Array.isArray(r.when) ? r.when : r.when === undefined ? [] : [null]).entries()) {
        if (!isObj(w) || typeof w.if !== 'string') {
          errors.push(`${at}.when[${j}] には if（文字列）が必要です`);
          continue;
        }
        when.push({ if: w.if, status: typeof w.status === 'number' ? w.status : 200, ...(w.body !== undefined ? { body: w.body } : {}) });
      }
      spec.routes.push({
        method: r.method.toUpperCase(),
        path: r.path,
        ...(r.op !== undefined ? { op: r.op as Op, table: r.table as string } : {}),
        ...(r.set !== undefined ? { set: r.set as Row } : {}),
        ...(r.status !== undefined ? { status: r.status as number } : {}),
        ...(r.body !== undefined ? { body: r.body } : {}),
        when,
      });
    });
  return { spec, errors };
}

/** Matches `/orders/:id` against `/orders/3`. Returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split('/').filter(Boolean);
  const xs = path.split('/').filter(Boolean);
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(':')) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

/** Splits `"POST /orders"` into method and path. */
export function parseRouteSpec(spec: string): { method: string; path: string } {
  const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(spec);
  if (!m) throw new Error(`ルートの指定が正しくありません: ${spec}（例: "POST /orders"）`);
  return { method: m[1].toUpperCase(), path: m[2] };
}

const notFound = (message: string): MockResponse => ({ status: 404, body: { message } });

export class ApiRouter {
  private routes: RouteSpec[] = [];
  private readonly handlers = new Map<string, { method: string; path: string; fn: RouteHandler }>();

  constructor(
    private readonly db: MemoryDb,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  setRoutes(routes: RouteSpec[]): void {
    this.routes = routes;
  }

  /** Registers a JS handler. It takes precedence over `when` / `op` and also defines the route when api.yaml lacks it. */
  route(spec: string, fn: RouteHandler): void {
    const { method, path } = parseRouteSpec(spec);
    this.handlers.set(`${method} ${path}`, { method, path, fn });
  }

  async handle(req: Omit<MockRequest, 'params'> & { params?: Record<string, string> }): Promise<MockResponse> {
    const method = req.method.toUpperCase();
    for (const h of this.handlers.values()) {
      const params = h.method === method ? matchPath(h.path, req.path) : null;
      if (params) return this.fromHandler(await h.fn({ ...req, method, params }, this.db));
    }
    for (const r of this.routes) {
      const params = r.method === method ? matchPath(r.path, req.path) : null;
      if (params) return this.run(r, { ...req, method, params });
    }
    return notFound(`ルートがありません: ${method} ${req.path}`);
  }

  private fromHandler(v: unknown): MockResponse {
    if (isObj(v) && typeof v.status === 'number') return { status: v.status, ...('body' in v ? { body: v.body } : {}) };
    return { status: v === undefined ? 204 : 200, ...(v === undefined ? {} : { body: v }) };
  }

  private run(r: RouteSpec, req: MockRequest): MockResponse {
    const scope = {
      body: req.body,
      params: req.params,
      query: req.query,
      hasTable: (t: string) => this.db.has(t),
      lookup: (t: string, k: unknown) => this.db.get(t, k),
    };
    for (const w of r.when) {
      const res = evalCondition(w.if, scope);
      if (res.error) this.onError(res.error);
      if (res.value) return { status: w.status, ...(w.body !== undefined ? { body: w.body } : {}) };
    }
    if (!r.op || !r.table) return { status: r.status ?? 200, ...(r.body !== undefined ? { body: r.body } : {}) };
    const table = r.table;
    const t = this.db.ensure(table);
    const key = req.params[t.key] ?? req.params.id ?? Object.values(req.params)[0];
    const input: Row = { ...(isObj(req.body) ? req.body : {}), ...(r.set ?? {}) };
    const missing = () => notFound(`データが見つかりません: ${table} ${key ?? ''}`.trim());
    switch (r.op) {
      case 'list':
        return { status: r.status ?? 200, body: this.db.list(table, { ...req.query, ...req.params }) };
      case 'get': {
        const row = this.db.get(table, key);
        return row ? { status: r.status ?? 200, body: row } : missing();
      }
      case 'insert':
        return { status: r.status ?? 201, body: this.db.insert(table, key !== undefined ? { ...input, [t.key]: key } : input) };
      case 'update': {
        const row = this.db.update(table, key, input);
        return row ? { status: r.status ?? 200, body: row } : missing();
      }
      case 'delete': {
        const row = this.db.remove(table, key);
        return row ? { status: r.status ?? 204 } : missing();
      }
    }
  }
}
