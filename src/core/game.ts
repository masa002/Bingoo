import { FREE_CELL, FREE_MASK, LINES, deriveCard, lineState, popcount } from './card'
import type { Rarity } from './prizes'
import { Rng } from './rng'

// 上位チャレンジの 3×3 カード。マスの位置は「行×3＋列」で、中央（4）が FREE
export const CH_FREE = 4
export const CH_LINES: readonly number[] = [0b000000111, 0b000111000, 0b111000000, 0b001001001, 0b010010010, 0b100100100, 0b100010001, 0b001010100]

export function challengeBingo(mask: number): boolean {
  return CH_LINES.some((line) => (mask & line) === line)
}

export interface Challenge {
  cells: number[] // 9 マスの番号（中央は 0）
  mask: number // 開いたマス（9 ビット）
  target: Rarity // 狙うランク（SR か UR）
}

export interface Player {
  idx: number
  cardNo: number
  name: string
  isMe: boolean
  cells: number[]
  mask: number
  filled: number // モグラに埋められたマス
  wild: number // 虹玉で開いたマス
  reach: number // リーチのライン数（上がった人は 0）
  bingoDraw: number | null // 上がった抽選回
  challenge: Challenge | null
}

// ある番号を出したときの影響。公開の前に計算して、演出の段階を決めるのに使う
export interface Impact {
  n: number
  hits: number // その番号を持っている人（上がった人は除く）
  newReach: number // リーチ 0 本 → 1 本以上になる人
  moreReach: number // リーチの本数が増える人（ダブルリーチ等）
  newBingo: number
  bingoIdx: number[]
  challengeIdx: number[] // この番号で上位チャレンジに成功する人
  me: { hit: boolean; reach: boolean; bingo: boolean; challenge: boolean }
}

export interface CellChange {
  cells: Map<number, number> // 人 → 変わったマス
  newReach: number
  newDouble: number
  lostReach: number
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
  private readonly challengers = new Set<number>()

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
        filled: 0,
        wild: 0,
        reach: 0,
        bingoDraw: null,
        challenge: null,
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

  get challengerCount(): number {
    return this.challengers.size
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
    const challengeIdx: number[] = []
    const me = { hit: false, reach: false, bingo: false, challenge: false }
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
    for (const idx of this.challengers) {
      const ch = this.players[idx].challenge!
      const cell = ch.cells.indexOf(n)
      if (cell >= 0 && challengeBingo(ch.mask | (1 << cell))) {
        challengeIdx.push(idx)
        if (idx === 0) me.challenge = true
      }
    }
    return { n, hits, newReach, moreReach, newBingo: bingoIdx.length, bingoIdx, challengeIdx, me }
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
      const bit = 1 << (e & 31)
      p.mask |= bit
      p.filled &= ~bit
      if (p.bingoDraw !== null) continue
      const s = lineState(p.mask)
      if (s.bingo > 0) {
        p.bingoDraw = this.drawn.length
        p.reach = 0
      } else {
        p.reach = s.reach
      }
    }
    for (const idx of this.challengers) {
      const ch = this.players[idx].challenge!
      const cell = ch.cells.indexOf(n)
      if (cell >= 0) ch.mask |= 1 << cell
    }
    this.winners.push(...impact.bingoIdx)
    return impact
  }

  // 上位チャレンジを始める。カードは、まだ出ていない数字だけで作る（作れなければ null）
  startChallenge(idx: number, target: Rarity, rng: Rng): Challenge | null {
    const pool = rng.shuffle(this.remaining())
    if (pool.length < 8) return null
    const cells = pool.slice(0, 8)
    cells.splice(CH_FREE, 0, 0)
    const ch: Challenge = { cells, mask: 1 << CH_FREE, target }
    this.players[idx].challenge = ch
    this.challengers.add(idx)
    return ch
  }

  endChallenge(idx: number): void {
    this.players[idx].challenge = null
    this.challengers.delete(idx)
  }

  activeChallengers(): number[] {
    return [...this.challengers]
  }

  // 新規ビンゴが合計 target 人に達するまでの、残りの抽選回数の見込み（このあとの順番をランダムに何通りか試す）
  estimateDrawsUntil(target: number, rng: Rng, runs = 8): number {
    if (target <= 0) return 0
    const rest = this.remaining()
    let total = 0
    for (let r = 0; r < runs; r++) {
      const masks = Int32Array.from(this.players, (p) => p.mask)
      const done = Uint8Array.from(this.players, (p) => (p.bingoDraw === null ? 0 : 1))
      let bingos = 0
      let k = 0
      for (const n of rng.shuffle([...rest])) {
        k++
        for (const e of this.index[n]) {
          const i = e >> 5
          if (done[i]) continue
          masks[i] |= 1 << (e & 31)
          if (LINES.some((line) => (masks[i] & line) === line)) {
            done[i] = 1
            bingos++
          }
        }
        if (bingos >= target) break
      }
      total += k
    }
    return total / runs
  }

  // 全員確定（虹玉）: まだ上がっていない全員のカードで、マスを 1 つ開ける。
  // ビンゴが完成するマスは避け、いちばんそろうマスを選ぶ（ここで大量にビンゴが出ると景品が一気に尽きるため）
  applyWild(rng: Rng): CellChange {
    const change: CellChange = { cells: new Map(), newReach: 0, newDouble: 0, lostReach: 0 }
    for (const p of this.players) {
      if (p.bingoDraw !== null) continue
      let best = -1
      let bestScore = -1
      for (let cell = 0; cell < 25; cell++) {
        const bit = 1 << cell
        if (cell === FREE_CELL || p.mask & bit) continue
        const s = lineState(p.mask | bit)
        if (s.bingo > 0) continue
        let most = 0
        for (const line of LINES) if (line & bit) most = Math.max(most, popcount((p.mask | bit) & line))
        const score = s.reach * 100 + most * 10 + rng.int(10)
        if (score > bestScore) {
          bestScore = score
          best = cell
        }
      }
      if (best < 0) continue
      const before = p.reach
      p.mask |= 1 << best
      p.wild |= 1 << best
      p.filled &= ~(1 << best)
      p.reach = lineState(p.mask).reach
      if (before === 0 && p.reach > 0) change.newReach++
      else if (before > 0 && p.reach > before) change.newDouble++
      change.cells.set(p.idx, best)
    }
    return change
  }

  // モグラ（BAD）: まだ上がっていない人の一部で、開いている穴を 1 つ埋める（FREE は対象外）。
  // onlyReach のときは、リーチの人だけを ratio の割合で狙い、リーチのラインの穴を埋める
  // （景品の残りに対してビンゴの出方が速すぎるときに、ペースを落とす調整役として使う）
  applyMole(rng: Rng, o: { ratio: number; forceMe?: boolean; onlyReach?: boolean }): CellChange {
    const change: CellChange = { cells: new Map(), newReach: 0, newDouble: 0, lostReach: 0 }
    for (const p of this.players) {
      if (p.bingoDraw !== null) continue
      const open = p.mask & ~FREE_MASK
      const forced = p.isMe && o.forceMe
      if (!open || (o.onlyReach && p.reach === 0 && !forced)) continue
      if (!forced && !rng.chance(o.ratio)) continue
      const cells: number[] = []
      for (let cell = 0; cell < 25; cell++) if (open & (1 << cell)) cells.push(cell)
      // リーチのラインにかかっているマスを狙う（ふだんは 4 割、調整役のときは必ず）
      const waiting = cells.filter((c) => LINES.some((line) => line & (1 << c) && popcount(p.mask & line) === 4))
      const cell = waiting.length && (o.onlyReach || rng.chance(0.4)) ? rng.pick(waiting) : rng.pick(cells)
      const before = p.reach
      p.mask &= ~(1 << cell)
      p.wild &= ~(1 << cell)
      p.filled |= 1 << cell
      p.reach = lineState(p.mask).reach
      if (p.reach < before) change.lostReach++
      change.cells.set(p.idx, cell)
    }
    return change
  }
}

// 3×3 のチャレンジカードが、あと k 回の抽選で成功する見込み（まだ出ていない u 個の番号から引く）。
// 選択画面に出す目安なので、決まった乱数での試行で十分
export function challengeChance(k: number, u: number, trials = 1500): number {
  if (k <= 0 || u < 8) return 0
  const rng = new Rng(`chance/${k}/${u}`)
  let wins = 0
  const pool = Array.from({ length: u }, (_, i) => i)
  for (let t = 0; t < trials; t++) {
    // カードの 8 個を 0〜7 とみなし、u 個から k 個を引いて 0〜7 に当たったものを開ける
    let mask = 1 << CH_FREE
    for (let i = 0; i < Math.min(k, u); i++) {
      const j = i + rng.int(u - i)
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
      const v = pool[i]
      if (v < 8) mask |= 1 << (v < CH_FREE ? v : v + 1)
    }
    if (challengeBingo(mask)) wins++
  }
  return wins / trials
}
