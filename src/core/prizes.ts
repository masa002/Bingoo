import { hash128, type Rng } from './rng'

export type Rarity = 'C' | 'R' | 'SR' | 'UR'
export type Glow = 'white' | 'gold' | 'rainbow' // パックの光（先バレ。ガセあり）
export type Edge = 'silver' | 'blue' | 'gold' // カードの縁（正直）

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

// 一番くじ型の有限在庫。並び順は開始時に決めて、そのハッシュを先に公開する
export function makePrizes(count: number, rng: Rng): Prize[] {
  const ur = count >= 5 ? 1 : 0
  const sr = Math.max(count >= 3 ? 1 : 0, Math.round(count * 0.1))
  const r = Math.round(count * 0.3)
  const c = Math.max(0, count - ur - sr - r)
  const list: Prize[] = []
  const add = (rarity: Rarity, k: number) => {
    for (let i = 0; i < k; i++) list.push({ id: 0, rarity, name: NAMES[rarity][i % NAMES[rarity].length] })
  }
  add('UR', ur)
  add('SR', sr)
  add('R', r)
  add('C', c)
  rng.shuffle(list)
  return list.map((p, i) => ({ ...p, id: i + 1 }))
}

// 開封の見た目。パックの光はガセを混ぜ、カードの縁はレア度どおりに出す
export function packLook(rarity: Rarity, rng: Rng): { glow: Glow; edge: Edge; upgrade: boolean } {
  switch (rarity) {
    case 'C':
      return { glow: 'white', edge: 'silver', upgrade: false }
    case 'R':
      return { glow: 'white', edge: 'blue', upgrade: false }
    case 'SR':
      return { glow: rng.chance(0.3) ? 'gold' : 'white', edge: 'gold', upgrade: false }
    case 'UR': {
      const glow = (['white', 'gold', 'rainbow'] as const)[rng.weighted([30, 40, 30])]
      return { glow, edge: 'gold', upgrade: rng.chance(0.5) }
    }
  }
}

// 抽選順と景品の並びをまとめたハッシュ。終了後にシードを公開すれば、誰でも照合できる
export async function commitHash(deck: readonly number[], prizes: readonly Prize[], salt: string): Promise<string> {
  const text = JSON.stringify({ deck, prizes: prizes.map((p) => `${p.rarity}:${p.name}`), salt })
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // file:// など暗号 API が無い環境の代わり（デモ用）
  return hash128(text).map((x) => x.toString(16).padStart(8, '0')).join('')
}
