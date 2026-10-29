import type { Rng } from './rng'

// 仮想参加者の表示名。実在の人名や部署名は使わない
const ANIMALS = [
  'しろくま', 'ぱんだ', 'きつね', 'うさぎ', 'ねこ', 'いぬ', 'たぬき', 'ぺんぎん', 'こあら', 'らっこ',
  'かわうそ', 'はりねずみ', 'あるぱか', 'ふくろう', 'いるか', 'くじら', 'りす', 'ひよこ', 'かめ', 'かえる',
]

export function fakeName(rng: Rng): string {
  return rng.pick(ANIMALS) + String(rng.int(1000)).padStart(3, '0')
}
