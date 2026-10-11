import { describe, expect, it } from 'vitest';
import { ApiError, BAD_RESPONSE, json } from './api.ts';

describe('json（エラー表示（共通））', () => {
  it('200 で JSON でない応答（古いサーバの index.html）は成功扱いにせず ApiError', async () => {
    const res = new Response('<!doctype html><div id="root"></div>', { status: 200, headers: { 'content-type': 'text/html' } });
    const err = await json(res).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(BAD_RESPONSE);
    expect((err as ApiError).code).toBe('bad-response');
  });

  it('JSON はそのまま返す', async () => {
    const res = new Response(JSON.stringify([{ number: 1 }]), { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await json(res)).toEqual([{ number: 1 }]);
  });

  it('空の本文は従来どおり {}', async () => {
    expect(await json(new Response(null, { status: 200 }))).toEqual({});
  });

  it('失敗の JSON は message を使う', async () => {
    const res = new Response(JSON.stringify({ error: 'not-found', message: '見つかりません' }), { status: 404 });
    await expect(json(res)).rejects.toMatchObject({ message: '見つかりません', status: 404 });
  });

  it('失敗で JSON でない本文は HTTP ステータスを表示', async () => {
    await expect(json(new Response('404 Not Found', { status: 404 }))).rejects.toMatchObject({ message: 'HTTP 404', status: 404 });
  });
});
