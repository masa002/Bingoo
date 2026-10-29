// 演出の時間の進め方。デモの速度変更と、途中での取り消しをまとめて扱う。
// 演出のコードは setTimeout を直接使わず、Timeline の wait / at を使う

export class Timeline {
  private readonly timers = new Map<number, () => void>()
  private aborted = false

  constructor(public speed = 1) {}

  get cancelled(): boolean {
    return this.aborted
  }

  // 演出上の ms を、今の速度での実際の ms にする（CSS アニメーションの長さなどに使う）
  ms(x: number): number {
    return x / this.speed
  }

  // 取り消されたら、待っている wait はすぐに解決する（後続の処理は cancelled を見て抜ける）
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.aborted) return resolve()
      const id = window.setTimeout(() => {
        this.timers.delete(id)
        resolve()
      }, Math.max(0, ms) / this.speed)
      this.timers.set(id, resolve)
    })
  }

  at(ms: number, fn: () => void): void {
    if (this.aborted) return
    const id = window.setTimeout(() => {
      this.timers.delete(id)
      if (!this.aborted) fn()
    }, Math.max(0, ms) / this.speed)
    this.timers.set(id, () => {})
  }

  cancel(): void {
    this.aborted = true
    for (const [id, resolve] of this.timers) {
      window.clearTimeout(id)
      resolve()
    }
    this.timers.clear()
  }
}

export const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html) node.innerHTML = html
  return node
}

// 同じクラスを付け直してもアニメーションは再生されないので、いったん外して付け直す
export function replay(node: HTMLElement, className: string): void {
  node.classList.remove(className)
  void node.offsetWidth
  node.classList.add(className)
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
