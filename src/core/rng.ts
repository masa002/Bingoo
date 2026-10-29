// シード文字列から決定的な乱数列を作る（sfc32）。
// デモではカードも抽選順もこれで作る。本番のカード導出は HMAC-SHA256 に差し替える想定。

export function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed: string) {
    const [a, b, c, d] = hash128(seed)
    this.a = a
    this.b = b
    this.c = c
    this.d = d
    for (let i = 0; i < 15; i++) this.next()
  }

  next(): number {
    const t0 = (this.a + this.b) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.d = (this.d + 1) | 0
    const t = (t0 + this.d) | 0
    this.c = (this.c + t) | 0
    return (t >>> 0) / 4294967296
  }

  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    return items
  }

  // 重み（合計は 1 でなくてよい）に従って添字を選ぶ。重み 0 は選ばない
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((s, w) => s + w, 0)
    let r = this.next() * total
    let last = 0
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] <= 0) continue
      last = i
      r -= weights[i]
      if (r < 0) return i
    }
    return last
  }
}
