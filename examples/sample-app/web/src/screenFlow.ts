export type Screen = 'List' | 'Input' | 'Confirm' | 'Done' | 'End';
export type ScreenEvent = '新規' | '次へ' | 'キャンセル' | '戻る' | '確定' | '一覧へ' | '終了';

export interface OrderInput {
  customer: string;
  sku: string;
  quantity: number;
}

export function validate(input: OrderInput): string[] {
  const errors: string[] = [];
  if (!input.customer || input.customer.length > 50) errors.push('顧客名は1〜50文字');
  if (!input.sku) errors.push('商品を選択してください');
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) errors.push('数量は1〜99');
  return errors;
}

/** Screen transition controller (docs/design/basic/order.md#画面遷移). */
export class ScreenFlow {
  screen: Screen = 'List';
  errors: string[] = [];
  input: OrderInput = { customer: '', sku: '', quantity: 1 };

  send(event: ScreenEvent): Screen {
    const s = this.screen;
    const next = ((): Screen | null => {
      if (s === 'List' && event === '新規') return 'Input';
      if (s === 'Input' && event === '次へ') {
        this.errors = validate(this.input);
        return this.errors.length ? 'Input' : 'Confirm';
      }
      if (s === 'Input' && event === 'キャンセル') return 'List';
      if (s === 'Confirm' && event === '戻る') return 'Input';
      if (s === 'Confirm' && event === '確定') return 'Done';
      if (s === 'Done' && event === '一覧へ') return 'List';
      if (s === 'Done' && event === '終了') return 'End';
      return null;
    })();
    if (next === null) throw new Error(`invalid event ${event} on ${s}`);
    this.screen = next;
    return next;
  }
}
