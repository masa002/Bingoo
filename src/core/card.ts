import { Rng } from './rng'

export const LETTERS = ['B', 'I', 'N', 'G', 'O'] as const

// マスの位置は「行×5＋列」。中央（12）が FREE
export const FREE_CELL = 12
export const FREE_MASK = 1 << FREE_CELL

// 12 本のライン（横 5・縦 5・斜め 2）をビットマスクで持つ
export const LINES: readonly number[] = (() => {
  const lines: number[] = []
  for (let r = 0; r < 5; r++) {
    let m = 0
    for (let c = 0; c < 5; c++) m |= 1 << (r * 5 + c)
    lines.push(m)
  }
  for (let c = 0; c < 5; c++) {
    let m = 0
    for (let r = 0; r < 5; r++) m |= 1 << (r * 5 + c)
    lines.push(m)
  }
  let d1 = 0
  let d2 = 0
  for (let i = 0; i < 5; i++) {
    d1 |= 1 << (i * 5 + i)
    d2 |= 1 << (i * 5 + (4 - i))
  }
  lines.push(d1, d2)
  return lines
})()

export function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export function columnOf(n: number): number {
  return Math.floor((n - 1) / 15)
}

export function labelOf(n: number): string {
  return LETTERS[columnOf(n)] + n
}

// シードとカード番号から決定的にカードを作る。cells[行×5＋列] が番号で、FREE は 0。
// 端末はこの関数で自分のカードを手元で作るので、カードの中身を配信しなくてよい
export function deriveCard(seed: string, cardNo: number): number[] {
  const rng = new Rng(`${seed}/card/${cardNo}`)
  const cells = new Array<number>(25).fill(0)
  for (let c = 0; c < 5; c++) {
    const pool = rng.shuffle(Array.from({ length: 15 }, (_, i) => c * 15 + i + 1))
    for (let r = 0; r < 5; r++) {
      if (r * 5 + c !== FREE_CELL) cells[r * 5 + c] = pool[r]
    }
  }
  return cells
}

export function maskOf(cells: readonly number[], drawn: Iterable<number>): number {
  const set = new Set(drawn)
  let mask = FREE_MASK
  cells.forEach((n, i) => {
    if (n && set.has(n)) mask |= 1 << i
  })
  return mask
}

export interface LineState {
  reach: number // あと 1 つのライン数
  bingo: number // 揃ったライン数
}

export function lineState(mask: number): LineState {
  let reach = 0
  let bingo = 0
  for (const line of LINES) {
    const k = popcount(mask & line)
    if (k === 5) bingo++
    else if (k === 4) reach++
  }
  return { reach, bingo }
}

// リーチのラインで、あと 1 つになっているマス
export function waitingCells(mask: number): number[] {
  const cells = new Set<number>()
  for (const line of LINES) {
    const rest = line & ~mask
    if (popcount(rest) === 1) cells.add(31 - Math.clz32(rest))
  }
  return [...cells]
}

// 揃ったラインに含まれるマス
export function bingoCells(mask: number): number[] {
  let all = 0
  for (const line of LINES) if ((mask & line) === line) all |= line
  const cells: number[] = []
  for (let i = 0; i < 25; i++) if (all & (1 << i)) cells.push(i)
  return cells
}
