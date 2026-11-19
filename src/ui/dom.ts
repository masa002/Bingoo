import { TIER_NAME, TIER_SHAPE } from '../core/show'

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (html) el.innerHTML = html
  return el
}

export function q<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (!el) throw new Error(`要素が見つかりません: ${selector}`)
  return el
}

// 固定サイズで組んだ画面（大画面 1920×1080、スマホ 390×844）を、親の大きさに合わせて縮小・中央寄せする
export function fit(el: HTMLElement, width: number, height: number): void {
  const parent = el.parentElement
  if (!parent) return
  const apply = () => {
    const s = Math.min(parent.clientWidth / width, parent.clientHeight / height)
    const x = (parent.clientWidth - width * s) / 2
    const y = (parent.clientHeight - height * s) / 2
    el.style.transform = `translate(${x}px, ${y}px) scale(${s})`
  }
  new ResizeObserver(apply).observe(parent)
  apply()
}

export const fmt = (n: number): string => n.toLocaleString('ja-JP')

// 演出の見方（色 → 何が起きそうか）の一覧の中身。色だけで伝えないよう、形と色の名前も並べる
export function tierGuide(words: readonly string[], quiet: string): string {
  return TIER_NAME.map((name, t) => `<li data-t="${t}"><i>${TIER_SHAPE[t]}</i><b>${name}</b><span>${t === 0 ? quiet : words[t]}</span></li>`).join('')
}

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function countUp(el: HTMLElement, to: number, ms: number, prefix = ''): void {
  const start = performance.now()
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / Math.max(1, ms))
    el.textContent = prefix + fmt(Math.round(to * (1 - Math.pow(1 - k, 3))))
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// アニメーションをやり直す（同じクラスを付け直しても再生されないため）
export function replay(el: HTMLElement, className: string): void {
  el.classList.remove(className)
  void el.offsetWidth
  el.classList.add(className)
}

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
