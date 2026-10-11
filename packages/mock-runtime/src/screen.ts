/** Shows one `[data-screen]` at a time (others get `hidden`). */
export class ScreenController {
  current: string | null = null;
  private readonly listeners = new Set<(screen: string) => void>();

  constructor(private readonly root: ParentNode) {}

  screens(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>('[data-screen]'));
  }

  element(id: string | null = this.current): HTMLElement | null {
    if (id === null) return null;
    return this.screens().find((s) => s.getAttribute('data-screen') === id) ?? null;
  }

  first(): string | null {
    return this.screens()[0]?.getAttribute('data-screen') ?? null;
  }

  /** Shows the screen. Throws when it does not exist. */
  show(id: string): void {
    const target = this.element(id);
    if (!target) throw new Error(`画面がありません: data-screen="${id}"`);
    for (const s of this.screens()) {
      if (s === target) s.removeAttribute('hidden');
      else s.setAttribute('hidden', '');
    }
    this.current = id;
    for (const l of this.listeners) l(id);
  }

  onChange(fn: (screen: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
