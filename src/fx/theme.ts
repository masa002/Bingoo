// 演出の共通の型と色。演出の部品はゲームの処理にも通信にも依存しない（後で使い回すため）

export type { Tier } from '../core/show'
export { TIER_NAME, TIER_SHAPE, TIER_WORD } from '../core/show'
export type { Glow, Rarity } from '../core/prizes'
import type { Tier } from '../core/show'
import type { Rarity } from '../core/prizes'

export type BallColor = 'white' | 'red' | 'gold' | 'rainbow'

// 段階の色: 青 緑 赤 金。虹（4）は単色ではなく RAINBOW のグラデーションで描く
export const TIER_COLOR: Readonly<Record<Tier, string>> = {
  0: '#3b82f6',
  1: '#22c55e',
  2: '#ef4444',
  3: '#f5c542',
  4: '#ffffff',
}

export const RAINBOW = ['#ff5a5a', '#ffb84d', '#fff15a', '#5aff8c', '#5ad2ff', '#a85aff'] as const
export const GOLD = ['#f5c542', '#ffe08a', '#fff4cc', '#d9a520'] as const

// CSS で虹を描くときのグラデーション（明るさは一定のまま、色だけを hue-rotate で回す）
export const RAINBOW_CSS =
  'conic-gradient(from 0deg, #ff5a5a, #ffb84d, #fff15a, #5aff8c, #5ad2ff, #a85aff, #ff5a5a)'

export const RARITY_COLOR: Readonly<Record<Rarity, string>> = {
  C: '#c0c6d6',
  R: '#3b82f6',
  SR: '#f5c542',
  UR: '#ff5ad2', // UR は虹で描く。単色が要るときの代表色
}

export const RARITY_NAME: Readonly<Record<Rarity, string>> = {
  C: 'コモン',
  R: 'レア',
  SR: 'スーパーレア',
  UR: 'ウルトラレア',
}

// 固定サイズで組んで、画面側で縮小表示する
export const STAGE_W = 1920
export const STAGE_H = 1080
export const PHONE_W = 390
export const PHONE_H = 844
