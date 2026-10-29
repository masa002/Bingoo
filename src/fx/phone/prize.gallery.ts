import { registerGallery, type GalleryItem } from '../gallery'
import { el } from '../runtime'
import { askChoice, playChallengeResult, playChallengeStart, playPackOpen, type PackSpec } from './prize'

// スマホの景品まわりのギャラリー（URL に ?gallery を付けると開く）。
// tl を渡すので、ギャラリーの速度に合わせ、別の項目を選ぶと途中でも片付く

const OPEN = 'スマホ: 景品の開封'
const CHOICE = 'スマホ: 景品の選択'
const CHALLENGE = 'スマホ: 上位チャレンジ'

const pack = (id: string, label: string, spec: PackSpec): GalleryItem => ({
  id: `prize-open-${id}`,
  group: OPEN,
  label,
  screen: 'phone',
  play: (host, tl) => playPackOpen(host, { ...spec, tl }),
})

type ChoiceArgs = Parameters<typeof askChoice>[1]

// 選んだ結果を画面の下に小さく出す（確かめる用）
const choice = (id: string, label: string, args: ChoiceArgs): GalleryItem => ({
  id: `prize-choice-${id}`,
  group: CHOICE,
  label,
  screen: 'phone',
  play: async (host, tl) => {
    const pick = await askChoice(host, { ...args, tl })
    if (!tl.cancelled) host.append(el('div', 'fxp-gal-note', `選んだもの: ${pick === 'challenge' ? '上位チャレンジ' : '受け取る'}`))
  },
})

registerGallery(
  pack('c', 'C（白い光 → 銀の縁 → すぐ）', { rarity: 'C', prize: 'お菓子詰め合わせ', glow: 'white', upgrade: false }),
  pack('r', 'R（白い光 → 青の縁 → きらり）', { rarity: 'R', prize: 'モバイルバッテリー', glow: 'white', upgrade: false }),
  pack('sr', 'SR（金の光 → 金の縁 → 金の爆発）', { rarity: 'SR', prize: 'ワイヤレスイヤホン', glow: 'gold', upgrade: false }),
  pack('ur', 'UR（虹の光 → フリーズ → 虹のヒビ）', { rarity: 'UR', prize: '特賞 最新ゲーム機', glow: 'rainbow', upgrade: false }),
  pack('ur-up', 'UR の昇格（白い光のガセ → 縁が金から虹に）', { rarity: 'UR', prize: '特賞 温泉旅館ペア宿泊券', glow: 'white', upgrade: true }),
  pack('ticket', 'ダブルチャンス券', { rarity: null, prize: 'ダブルチャンス券 2 口', glow: 'white', upgrade: false }),
  pack('rankup', 'ランクアップ付き（在庫切れで C → R）', {
    rarity: 'R',
    prize: 'グルメカタログ',
    glow: 'white',
    upgrade: false,
    rankUp: { from: 'C', to: 'R' },
  }),
  pack('rankup-ur', 'ランクアップ付き（在庫切れで SR → UR）', {
    rarity: 'UR',
    prize: '特賞 最新ゲーム機',
    glow: 'gold',
    upgrade: false,
    rankUp: { from: 'SR', to: 'UR' },
  }),
  choice('ok', 'チャレンジ可（C → SR を狙う、目安つき）', {
    rarity: 'C',
    prize: 'お菓子詰め合わせ',
    seconds: 10,
    challenge: { allowed: true, target: 'SR', chance: 0.34 },
  }),
  choice('ng', 'チャレンジ不可（終盤）', {
    rarity: 'R',
    prize: 'グルメカタログ',
    seconds: 10,
    challenge: { allowed: false, target: 'SR', reason: '残りの数字が少ないため、チャレンジできません' },
  }),
  choice('double', '倍々（SR を手放して UR を狙う）', {
    rarity: 'SR',
    prize: 'スマートウォッチ',
    seconds: 10,
    challenge: { allowed: true, target: 'UR', chance: 0.18 },
  }),
  {
    id: 'prize-challenge-start',
    group: CHALLENGE,
    label: '開始（SR を狙う）',
    screen: 'phone',
    play: (host, tl) => playChallengeStart(host, { tl, target: 'SR' }),
  },
  {
    id: 'prize-challenge-start-ur',
    group: CHALLENGE,
    label: '開始（倍々で UR を狙う）',
    screen: 'phone',
    play: (host, tl) => playChallengeStart(host, { tl, target: 'UR' }),
  },
  {
    id: 'prize-challenge-win-sr',
    group: CHALLENGE,
    label: '成功（SR）',
    screen: 'phone',
    play: (host, tl) => playChallengeResult(host, { tl, success: true, rarity: 'SR', prize: 'スマートウォッチ' }),
  },
  {
    id: 'prize-challenge-win-ur',
    group: CHALLENGE,
    label: '成功（UR・縁が虹に昇格）',
    screen: 'phone',
    play: (host, tl) => playChallengeResult(host, { tl, success: true, rarity: 'UR', prize: '特賞 温泉旅館ペア宿泊券' }),
  },
  {
    id: 'prize-challenge-lose',
    group: CHALLENGE,
    label: '失敗（景品なし）',
    screen: 'phone',
    play: (host, tl) => playChallengeResult(host, { tl, success: false, rarity: 'SR' }),
  },
)
