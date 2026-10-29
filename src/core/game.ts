import { FREE_MASK, deriveCard, lineState } from './card'
import { Rng } from './rng'

export interface Player {
  idx: number
  cardNo: number
  name: string
  isMe: boolean
  cells: number[]
  mask: number
  reach: number // リーチのライン数（上がった人は 0）
  bingoDraw: number | null // 上がった抽選回
}

// ある番号を出したときの影響。公開の前に計算して、演出の段階を決めるのに使う
export interface Impact {
  n: number
  hits: number // その番号を持っている人（上がった人は除く）
  newReach: number // リーチ 0 本 → 1 本以上になる人
  moreReach: number // リーチの本数が増える人（ダブルリーチ等）
  newBingo: number
  bingoIdx: number[]
  me: { hit: boolean; reach: boolean; bingo: boolean }
}

// 全員のカードと抽選の列。純粋な計算だけで、通信も描画も知らない
export class Game {
  readonly seed: string
  readonly size: number
  readonly players: Player[] = []
  readonly deck: number[]
  readonly drawn: number[] = []
  readonly winners: number[] = []
  private readonly drawnSet = new Set<number>()
  // 番号 → (人 × 32 + マス) の列。1 抽選の更新が「その番号を持つ人」だけで済む
  private readonly index: Int32Array[] = []

  constructor(opts: { seed: string; size: number }, nameOf: (rng: Rng) => string) {
    this.seed = opts.seed
    this.size = opts.size
    const rng = new Rng(`${opts.seed}/players`)
    const used = new Set<number>()
    for (let i = 0; i < opts.size; i++) {
      let cardNo = 0
      do {
        cardNo = 1 + rng.int(99999)
      } while (used.has(cardNo))
      used.add(cardNo)
      this.players.push({
        idx: i,
        cardNo,
        name: i === 0 ? 'あなた' : nameOf(rng),
        isMe: i === 0,
        cells: deriveCard(opts.seed, cardNo),
        mask: FREE_MASK,
        reach: 0,
        bingoDraw: null,
      })
    }
    const counts = new Array<number>(76).fill(0)
    for (const p of this.players) for (const n of p.cells) if (n) counts[n]++
    for (let n = 0; n <= 75; n++) this.index.push(new Int32Array(counts[n]))
    const fill = new Array<number>(76).fill(0)
    for (const p of this.players) {
      p.cells.forEach((n, cell) => {
        if (n) this.index[n][fill[n]++] = p.idx * 32 + cell
      })
    }
    this.deck = new Rng(`${opts.seed}/deck`).shuffle(Array.from({ length: 75 }, (_, i) => i + 1))
  }

  get me(): Player {
    return this.players[0]
  }

  get drawCount(): number {
    return this.drawn.length
  }

  isDrawn(n: number): boolean {
    return this.drawnSet.has(n)
  }

  remaining(): number[] {
    return this.deck.filter((n) => !this.drawnSet.has(n))
  }

  nextInDeck(): number | undefined {
    return this.deck.find((n) => !this.drawnSet.has(n))
  }

  reachHolders(): number {
    let count = 0
    for (const p of this.players) if (p.bingoDraw === null && p.reach > 0) count++
    return count
  }

  preview(n: number): Impact {
    let hits = 0
    let newReach = 0
    let moreReach = 0
    const bingoIdx: number[] = []
    const me = { hit: false, reach: false, bingo: false }
    for (const e of this.index[n]) {
      const p = this.players[e >> 5]
      if (p.isMe) me.hit = true
      if (p.bingoDraw !== null) continue
      hits++
      const s = lineState(p.mask | (1 << (e & 31)))
      if (s.bingo > 0) {
        bingoIdx.push(p.idx)
        if (p.isMe) me.bingo = true
      } else if (s.reach > p.reach) {
        if (p.reach === 0) newReach++
        else moreReach++
        if (p.isMe) me.reach = true
      }
    }
    return { n, hits, newReach, moreReach, newBingo: bingoIdx.length, bingoIdx, me }
  }

  previewAll(): Impact[] {
    return this.remaining().map((n) => this.preview(n))
  }

  apply(n: number): Impact {
    const impact = this.preview(n)
    this.drawn.push(n)
    this.drawnSet.add(n)
    for (const e of this.index[n]) {
      const p = this.players[e >> 5]
      p.mask |= 1 << (e & 31)
      if (p.bingoDraw !== null) continue
      const s = lineState(p.mask)
      if (s.bingo > 0) {
        p.bingoDraw = this.drawn.length
        p.reach = 0
      } else {
        p.reach = s.reach
      }
    }
    this.winners.push(...impact.bingoIdx)
    return impact
  }
}
