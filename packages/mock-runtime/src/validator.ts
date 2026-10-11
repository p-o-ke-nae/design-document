export interface FieldError {
  key: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: FieldError[];
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const isInput = (el: Element): el is HTMLInputElement => el.tagName === 'INPUT';
const keyOf = (el: Element) => el.getAttribute('data-testid') ?? el.getAttribute('name') ?? el.id ?? '';

/** Checks required / min / max / maxlength / pattern of the inputs in the scope (HTML constraint rules, evaluated explicitly). */
export class Validator {
  validate(scope: ParentNode): ValidationResult {
    const errors: FieldError[] = [];
    for (const el of Array.from(scope.querySelectorAll<Field>('input, select, textarea'))) {
      if (el.disabled || (isInput(el) && ['hidden', 'button', 'submit', 'reset', 'image'].includes(el.type))) continue;
      const message = this.check(el);
      if (message) errors.push({ key: keyOf(el), message });
    }
    return { ok: errors.length === 0, errors };
  }

  private check(el: Field): string | null {
    const label = keyOf(el);
    if (isInput(el) && el.type === 'checkbox') return el.required && !el.checked ? `${label} を選択してください` : null;
    const v = el.value;
    if (el.hasAttribute('required') && v.trim() === '') return `${label} は必須です`;
    if (v === '') return null;
    const maxLength = Number(el.getAttribute('maxlength'));
    if (el.hasAttribute('maxlength') && Number.isFinite(maxLength) && v.length > maxLength) return `${label} は ${maxLength} 文字以内にしてください`;
    const minLength = Number(el.getAttribute('minlength'));
    if (el.hasAttribute('minlength') && Number.isFinite(minLength) && v.length < minLength) return `${label} は ${minLength} 文字以上にしてください`;
    if (isInput(el) && (el.type === 'number' || el.type === 'range')) {
      const n = Number(v);
      if (!Number.isFinite(n)) return `${label} は数値にしてください`;
      const min = el.getAttribute('min');
      const max = el.getAttribute('max');
      if (min !== null && min !== '' && n < Number(min)) return `${label} は ${min} 以上にしてください`;
      if (max !== null && max !== '' && n > Number(max)) return `${label} は ${max} 以下にしてください`;
    }
    const pattern = el.getAttribute('pattern');
    if (pattern) {
      try {
        if (!new RegExp(`^(?:${pattern})$`, 'u').test(v)) return `${label} の形式が正しくありません`;
      } catch {
        /* invalid pattern is ignored like browsers do */
      }
    }
    return null;
  }
}
