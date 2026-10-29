import { hash128, type Rng } from './rng'

export type Rarity = 'C' | 'R' | 'SR' | 'UR'
export type Glow = 'white' | 'gold' | 'rainbow' // パックの光（先バレ。ガセあり）

export const RANKS: readonly Rarity[] = ['C', 'R', 'SR', 'UR']

export interface Prize {
  id: number
  rarity: Rarity
  name: string
}

const NAMES: Record<Rarity, string[]> = {
  UR: ['特賞 最新ゲーム機', '特賞 温泉旅館ペア宿泊券'],
  SR: ['ワイヤレスイヤホン', 'スマートウォッチ', 'ロボット掃除機', 'コーヒーメーカー'],
  R: ['モバイルバッテリー', 'グルメカタログ', 'Bluetooth スピーカー', '高級タオルセット', 'ホットアイマスク'],
  C: ['お菓子詰め合わせ', 'ドリップコーヒーセット', 'ハンドクリーム', 'オリジナルステッカー', 'エコバッグ', '入浴剤セット'],
}

const DC_NAMES = ['ダブルチャンス賞 お菓子セット', 'ダブルチャンス賞 QUO カード', 'ダブルチャンス賞 ご当地グルメ']

// 景品の在庫。下位（C・R）は通常のビンゴ、上位（SR・UR）は上位チャレンジ用。
// 一番くじ型で数が決まっていて、足りなければ 1 つ上のランクから出す
export class PrizeStock {
  private readonly lists: Record<Rarity, Prize[]> = { C: [], R: [], SR: [], UR: [] }
  readonly lowerTotal: number
  readonly upperTotal: number
  private nextId = 1

  constructor(lower: number, upper: number, rng: Rng) {
    const r = Math.max(lower >= 3 ? 1 : 0, Math.round(lower * 0.3))
    this.add('R', r)
    this.add('C', lower - r)
    const ur = upper >= 3 ? 1 : 0
    this.add('UR', ur)
    this.add('SR', upper - ur)
    for (const list of Object.values(this.lists)) rng.shuffle(list)
    this.lowerTotal = lower
    this.upperTotal = upper
  }

  left(r: Rarity): number {
    return this.lists[r].length
  }

  get lowerLeft(): number {
    return this.left('C') + this.left('R')
  }

  get upperLeft(): number {
    return this.left('SR') + this.left('UR')
  }

  // 通常のビンゴ: 下位の在庫から、残りの数に比例した確率で 1 つ（パックを開けるのと同じ）
  takeLower(rng: Rng): Prize | null {
    const c = this.left('C')
    const r = this.left('R')
    if (c + r === 0) return null
    return this.lists[rng.int(c + r) < c ? 'C' : 'R'].pop()!
  }

  // 指定のランクから 1 つ。無ければ 1 つ上のランクへ上がっていく
  takeAtLeast(r: Rarity): Prize | null {
    for (let i = RANKS.indexOf(r); i < RANKS.length; i++) {
      const p = this.lists[RANKS[i]].pop()
      if (p) return p
    }
    return null
  }

  // 指定のランク以上が残っているか（上位チャレンジを出してよいかの判断に使う）
  hasAtLeast(r: Rarity): boolean {
    return RANKS.slice(RANKS.indexOf(r)).some((x) => this.left(x) > 0)
  }

  // 上位チャレンジに挑んだ人が手放した景品を在庫に戻す
  giveBack(p: Prize): void {
    this.lists[p.rarity].push(p)
  }

  // 終了時に余った上位（ダブルチャンスに回す）
  takeAllUpper(): Prize[] {
    return [...this.lists.UR.splice(0), ...this.lists.SR.splice(0)]
  }

  // ハッシュの公開用に、並び順の目録を作る
  manifest(): string[] {
    return RANKS.flatMap((r) => this.lists[r].map((p) => `${p.id}:${r}:${p.name}`))
  }

  private add(rarity: Rarity, k: number): void {
    for (let i = 0; i < k; i++) this.lists[rarity].push({ id: this.nextId++, rarity, name: NAMES[rarity][i % NAMES[rarity].length] })
  }
}

export function doubleChancePrizes(count: number): Prize[] {
  return Array.from({ length: count }, (_, i) => ({ id: 1000 + i, rarity: 'C' as const, name: DC_NAMES[i % DC_NAMES.length] }))
}

// 開封の見た目。パックの光はガセを混ぜ、カードの縁はレア度どおりに出す
export function packLook(rarity: Rarity | null, rng: Rng): { glow: Glow; upgrade: boolean } {
  switch (rarity) {
    case 'SR':
      return { glow: rng.chance(0.3) ? 'gold' : 'white', upgrade: false }
    case 'UR':
      return { glow: (['white', 'gold', 'rainbow'] as const)[rng.weighted([30, 40, 30])], upgrade: rng.chance(0.5) }
    default:
      return { glow: rng.chance(0.05) ? 'gold' : 'white', upgrade: false } // C・R にもまれに金のガセ
  }
}

// 抽選順と景品の並びをまとめたハッシュ。終了後にシードを公開すれば、誰でも照合できる
export async function commitHash(deck: readonly number[], manifest: readonly string[], salt: string): Promise<string> {
  const text = JSON.stringify({ deck, manifest, salt })
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // file:// など暗号 API が無い環境の代わり（デモ用）
  return hash128(text).map((x) => x.toString(16).padStart(8, '0')).join('')
}
