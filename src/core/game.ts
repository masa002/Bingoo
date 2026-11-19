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
}

// ある番号が、その人のカードにとって何を意味するか（スマホの期待度を決めるのに使う）
export const OUT = { none: 0, hit: 1, reach: 2, bingo: 3 } as const
// いまのカードで、このあと起こりうること（ビットの和）
export const CAN = { hit: 1, reach: 2, bingo: 4 } as const

// 保存用。カードの中身はシードとカード番号から作り直せるので、変わるものだけを持つ
export interface GameDump {
  seed: string
  deckSeed: string
  players: { name: string; cardNo: number }[]
  mask: number[]
  filled: number[]
  wild: number[]
  bingoDraw: (number | null)[]
  challenges: [number, Challenge][]
  drawn: number[]
  winners: number[]
}

// 全員のカードと抽選の列。純粋な計算だけで、通信も描画も知らない
export class Game {
  readonly seed: string
  readonly players: Player[] = []
  readonly deck: number[]
  readonly drawn: number[] = []
  readonly winners: number[] = []
  private readonly drawnSet = new Set<number>()
  // 番号 → (人 × 32 + マス) の列。1 抽選の更新が「その番号を持つ人」だけで済む
  private readonly index: number[][] = Array.from({ length: 76 }, () => [])
  private readonly challengers = new Set<number>()
  private readonly usedCards = new Set<number>()
  readonly deckSeed: string

  // デモは、最初から size 人（0 番が自分、ほかは仮想の参加者）で作る。
  // 本番は size を 0 にして、参加のたびに addPlayer で足す。seed はカードを作るシードで、端末にも配る。
  // 抽選順のシード（deckSeed）は別にして、サーバーの外に出さない（同じにすると、端末から抽選順が分かってしまう）
  constructor(opts: { seed: string; size: number; deckSeed?: string }, nameOf: (rng: Rng) => string) {
    this.seed = opts.seed
    this.deckSeed = opts.deckSeed ?? opts.seed
    const rng = new Rng(`${opts.seed}/players`)
    for (let i = 0; i < opts.size; i++) {
      let cardNo = 0
      do {
        cardNo = 1 + rng.int(99999)
      } while (this.usedCards.has(cardNo))
      this.seat(cardNo, i === 0 ? 'あなた' : nameOf(rng), i === 0)
    }
    this.deck = new Rng(`${this.deckSeed}/deck`).shuffle(Array.from({ length: 75 }, (_, i) => i + 1))
  }

  get size(): number {
    return this.players.length
  }

  get me(): Player {
    return this.players[0]
  }

  private seat(cardNo: number, name: string, isMe: boolean): Player {
    this.usedCards.add(cardNo)
    const p: Player = {
      idx: this.players.length,
      cardNo,
      name,
      isMe,
      cells: deriveCard(this.seed, cardNo),
      mask: FREE_MASK,
      filled: 0,
      wild: 0,
      reach: 0,
      bingoDraw: null,
      challenge: null,
    }
    this.players.push(p)
    p.cells.forEach((n, cell) => {
      if (n) this.index[n].push(p.idx * 32 + cell)
    })
    return p
  }

  // 参加者を 1 人足す（本番）。途中から入った人のカードは、もう出た番号を開けた状態で始める。
  // 入った時点でビンゴになっているカードは配らない（何度か引き直してもだめなら null。終盤はもう入れない）
  addPlayer(name: string): Player | null {
    const rng = new Rng(`${this.seed}/seat/${this.players.length}`)
    for (let tries = 0; tries < 40; tries++) {
      const cardNo = 1 + rng.int(99999)
      if (this.usedCards.has(cardNo)) continue
      const cells = deriveCard(this.seed, cardNo)
      let mask = FREE_MASK
      cells.forEach((n, cell) => {
        if (n && this.drawnSet.has(n)) mask |= 1 << cell
      })
      const s = lineState(mask)
      if (s.bingo > 0) continue
      const p = this.seat(cardNo, name, false)
      p.mask = mask
      p.reach = s.reach
      return p
    }
    return null
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
      const s = lineState(p.mask | (1 << (e & 31)), p.filled)
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

  // 番号 n が、全員それぞれのカードにとって何を意味するか（OUT の値。人の番号で引く）
  outcomes(n: number): Uint8Array {
    const out = new Uint8Array(this.players.length)
    for (const e of this.index[n]) {
      const p = this.players[e >> 5]
      if (p.bingoDraw !== null) continue
      const s = lineState(p.mask | (1 << (e & 31)), p.filled)
      out[p.idx] = s.bingo > 0 ? OUT.bingo : s.reach > p.reach ? OUT.reach : OUT.hit
    }
    for (const idx of this.challengers) {
      const ch = this.players[idx].challenge!
      const cell = ch.cells.indexOf(n)
      if (cell >= 0) out[idx] = challengeBingo(ch.mask | (1 << cell)) ? OUT.bingo : Math.max(out[idx], OUT.hit)
    }
    return out
  }

  // 残りの番号のどれかで、全員それぞれに起こりうること（CAN のビットの和。人の番号で引く）
  possible(): Uint8Array {
    const can = new Uint8Array(this.players.length)
    const bit = [0, CAN.hit, CAN.hit | CAN.reach, CAN.hit | CAN.bingo]
    for (const n of this.remaining()) {
      const out = this.outcomes(n)
      for (const e of this.index[n]) can[e >> 5] |= bit[out[e >> 5]]
      for (const idx of this.challengers) can[idx] |= bit[out[idx]]
    }
    return can
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
      const s = lineState(p.mask, p.filled)
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

  // 保存した状態から戻す（restoreGame から呼ぶ）。
  // 参加者の表（d.players）のほうが、マスの状態（d.mask など）より長くてもよい: 参加のたびに保存するのは表だけにして、
  // 全員分のマスの状態は、抽選などで変わったときにだけ保存する（1 万人の受付で、1 人ごとに全員分を書かないため）。
  // 足りない人は、そのあと何も起きていないので、「いま参加した」のと同じ形（もう出た番号が開いている）で戻せる
  load(d: GameDump): void {
    for (const n of d.drawn) {
      this.drawn.push(n)
      this.drawnSet.add(n)
    }
    d.players.forEach((x, i) => {
      const p = this.seat(x.cardNo, x.name, false)
      if (i < d.mask.length) {
        p.mask = d.mask[i]
        p.filled = d.filled[i]
        p.wild = d.wild[i]
        p.bingoDraw = d.bingoDraw[i]
      } else {
        p.cells.forEach((n, cell) => {
          if (n && this.drawnSet.has(n)) p.mask |= 1 << cell
        })
      }
      p.reach = p.bingoDraw === null ? lineState(p.mask, p.filled).reach : 0
    })
    for (const [idx, ch] of d.challenges) {
      this.players[idx].challenge = ch
      this.challengers.add(idx)
    }
    this.winners.push(...d.winners)
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
    const change: CellChange = { cells: new Map(), newReach: 0, newDouble: 0 }
    for (const p of this.players) {
      if (p.bingoDraw !== null) continue
      let best = -1
      let bestScore = -1
      for (let cell = 0; cell < 25; cell++) {
        const bit = 1 << cell
        if (cell === FREE_CELL || p.mask & bit) continue
        const s = lineState(p.mask | bit, p.filled & ~bit)
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
      p.reach = lineState(p.mask, p.filled).reach
      if (before === 0 && p.reach > 0) change.newReach++
      else if (before > 0 && p.reach > before) change.newDouble++
      change.cells.set(p.idx, best)
    }
    return change
  }

  // モグラ（緊急クエスト）が狙うマス: リーチのラインにかかっている開いたマス（リーチでなければ、開いたマスのどれか。FREE は対象外）。
  // 番号がもう出ているマスだけを狙う。虹玉で開いたマスは番号がこれから出るので、埋めても「もう開かない」にならない
  aimMole(p: Player, rng: Rng): number | null {
    const cells: number[] = []
    for (let cell = 0; cell < 25; cell++) {
      if (cell !== FREE_CELL && p.mask & (1 << cell) && this.drawnSet.has(p.cells[cell])) cells.push(cell)
    }
    if (!cells.length) return null
    const waiting = cells.filter((c) => LINES.some((line) => line & (1 << c) && popcount(p.mask & line) === 4 && !(line & ~p.mask & p.filled)))
    return rng.pick(waiting.length ? waiting : cells)
  }

  // モグラに穴を埋められる（その番号はもう出ているので、虹玉で開け直さない限り開かない）。リーチが減ったら true
  fillByMole(idx: number, cell: number): boolean {
    const p = this.players[idx]
    const before = p.reach
    p.mask &= ~(1 << cell)
    p.wild &= ~(1 << cell)
    p.filled |= 1 << cell
    p.reach = lineState(p.mask, p.filled).reach
    return p.reach < before
  }
}

export function dumpGame(g: Game): GameDump {
  return {
    seed: g.seed,
    deckSeed: g.deckSeed,
    players: g.players.map((p) => ({ name: p.name, cardNo: p.cardNo })),
    mask: g.players.map((p) => p.mask),
    filled: g.players.map((p) => p.filled),
    wild: g.players.map((p) => p.wild),
    bingoDraw: g.players.map((p) => p.bingoDraw),
    challenges: g.activeChallengers().map((idx) => [idx, g.players[idx].challenge!]),
    drawn: g.drawn,
    winners: g.winners,
  }
}

export function restoreGame(d: GameDump): Game {
  const g = new Game({ seed: d.seed, deckSeed: d.deckSeed, size: 0 }, () => '')
  g.load(d)
  return g
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
