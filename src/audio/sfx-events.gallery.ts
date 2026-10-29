import { registerGallery, type GalleryItem } from '../fx/gallery'
import { el, type Timeline } from '../fx/runtime'
import { TIER_NAME, type Glow, type Rarity, type Tier } from '../fx/theme'
import { sfx } from './index'

// イベント・景品・ガラポン・UI の効果音をギャラリーに登録する（URL に ?gallery を付けて開く）。
// 単発の音はそのまま鳴らし、あおり・モグラ・パック開封・チャレンジ・ガラポンは、本番に近い流れで続けて鳴らす

const CARD = '音: カード・ビンゴ'
const AORI = '音: あおり'
const EVENT = '音: モグラ・虹玉'
const PACK = '音: 景品パック'
const CHOICE = '音: 選択・チャレンジ'
const DC = '音: ダブルチャンス'

function item(id: string, group: string, label: string, play: GalleryItem['play']): GalleryItem {
  return { id: `sfx-ev-${id}`, group, label, screen: 'sound', play }
}

// 手元のあおり: 始まり → 高まり（4 回、だんだん詰まる）→ 成功／失敗
async function aoriFlow(tl: Timeline, tier: Tier, success: boolean): Promise<void> {
  sfx.aoriStart(tier)
  await tl.wait(tier === 4 ? 1500 : 900)
  for (let i = 0; i < 4; i++) {
    if (tl.cancelled) return
    sfx.aoriPulse(tier)
    await tl.wait(620 - i * 70)
  }
  if (tl.cancelled) return
  if (success) sfx.aoriSuccess(tier)
  else sfx.aoriFail()
  await tl.wait(2000)
}

// モグラ: 顔を出す → 掘る（2 回）→ 埋められた／セーフ
async function moleFlow(tl: Timeline, hit: boolean): Promise<void> {
  sfx.moleAppear()
  await tl.wait(800)
  for (let i = 0; i < 2; i++) {
    if (tl.cancelled) return
    sfx.moleDig()
    await tl.wait(650)
  }
  if (tl.cancelled) return
  if (hit) sfx.moleFill()
  else sfx.moleSafe()
  await tl.wait(1200)
}

// パック開封: 出てくる → 破る → めくる → レア度
async function packFlow(tl: Timeline, glow: Glow, r: Rarity | null): Promise<void> {
  sfx.packAppear(glow)
  await tl.wait(glow === 'rainbow' ? 2200 : 1500)
  if (tl.cancelled) return
  sfx.packTear()
  await tl.wait(700)
  if (tl.cancelled) return
  sfx.cardFlip()
  await tl.wait(350)
  if (tl.cancelled) return
  sfx.rarity(r)
  await tl.wait(r === 'UR' ? 4000 : 2000)
}

// 選択の残り秒数（本番は 10 秒から）
async function countdownFlow(tl: Timeline, from: number): Promise<void> {
  for (let s = from; s >= 0; s--) {
    if (tl.cancelled) return
    sfx.countdown(s)
    await tl.wait(1000)
  }
}

// 上位チャレンジ: 選ぶ → 3×3 を配る → 結果
async function challengeFlow(tl: Timeline, success: boolean): Promise<void> {
  sfx.choose('challenge')
  await tl.wait(1100)
  if (tl.cancelled) return
  sfx.challengeDeal()
  await tl.wait(1600)
  if (tl.cancelled) return
  if (success) sfx.challengeSuccess()
  else sfx.challengeFail()
  await tl.wait(2200)
}

// 回転の速さを大きく出す（音の確認用の最小限の表示）
function meter(host: HTMLElement): HTMLElement {
  const m = el('div')
  m.style.cssText =
    "position:absolute;inset:0;display:grid;place-items:center;color:#e8ecff;font:900 120px/1 'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif"
  host.append(m)
  return m
}

// 連打の見本。画面の抽選器と同じ物理（1 打で +0.45、上限 3 回転/秒に近いほど伸びにくい、摩擦 0.8/秒）で速さを作り、
// ゆっくり回し始め → だんだん速く連打 → 手を止めて減速 → 止める、の順に setSpeed を送る
async function garaponTaps(host: HTMLElement, tl: Timeline, ms = 7000): Promise<void> {
  const voice = sfx.garaponStart()
  const m = meter(host)
  const step = 50
  const handsOff = ms - 2500
  let rps = 0
  let nextTap = 0
  for (let t = 0; t < ms && !tl.cancelled; t += step) {
    if (t < handsOff && t >= nextTap) {
      const k = rps / 3
      rps = Math.min(3, rps + 0.45 * Math.max(0, 1 - k * k))
      nextTap = t + (t < handsOff * 0.33 ? 450 : t < handsOff * 0.66 ? 220 : 130)
    }
    rps *= Math.exp(-0.8 * (step / 1000))
    if (rps < 0.004) rps = 0
    voice.setSpeed(rps)
    m.textContent = `${rps.toFixed(2)} 回転/秒${t < handsOff ? '' : '（手を止めた）'}`
    await tl.wait(step)
  }
  voice.stop()
  m.textContent = '止める'
  if (!tl.cancelled) await tl.wait(1500)
  m.remove()
}

// 速さを段階で変えて、密度と音程の変わり方を確かめる（画面の抽選器の上限は 3）
async function garaponSteps(host: HTMLElement, tl: Timeline): Promise<void> {
  const voice = sfx.garaponStart()
  const m = meter(host)
  for (const rps of [0.3, 0.6, 1, 1.5, 2, 3, 4.5, 6]) {
    if (tl.cancelled) break
    voice.setSpeed(rps)
    m.textContent = `${rps} 回転/秒`
    await tl.wait(1300)
  }
  voice.stop()
  m.textContent = '止める'
  if (!tl.cancelled) await tl.wait(1500)
}

// 抽選の流れ: 回す → 止める → 玉が出る → 結果
async function garaponFlow(host: HTMLElement, tl: Timeline, result: 'red' | 'gold' | 'rainbow' | 'miss'): Promise<void> {
  await garaponTaps(host, tl, 5000)
  if (tl.cancelled) return
  sfx.garaponDrop()
  await tl.wait(1100)
  if (tl.cancelled) return
  if (result === 'miss') sfx.garaponMiss()
  else sfx.garaponWin(result)
  await tl.wait(3500)
}

const tiers: Tier[] = [0, 1, 2, 3, 4]
const glows: [Glow, string][] = [
  ['white', '白'],
  ['gold', '金'],
  ['rainbow', '虹'],
]
const rarities: [Rarity | null, string][] = [
  ['C', 'C'],
  ['R', 'R'],
  ['SR', 'SR'],
  ['UR', 'UR'],
  [null, 'ダブルチャンス券'],
]

registerGallery(
  // カード・リーチ・ビンゴ
  item('stamp', CARD, '穴が開く', () => sfx.stamp()),
  item('stamp-run', CARD, '穴が続けて開く（5 回）', async (_host, tl) => {
    for (let i = 0; i < 5 && !tl.cancelled; i++) {
      sfx.stamp()
      await tl.wait(320)
    }
  }),
  item('reach-1', CARD, 'リーチ（1 本）', () => sfx.reach(1)),
  item('reach-2', CARD, 'ダブルリーチ（2 本）', () => sfx.reach(2)),
  item('bingo', CARD, 'ビンゴ', () => sfx.bingo()),

  // 手元のあおり
  ...tiers.map((t) => item(`aori-ok-${t}`, AORI, `あおり ${TIER_NAME[t]} → 成功`, (_host, tl) => aoriFlow(tl, t, true))),
  ...([1, 2, 3] as Tier[]).map((t) => item(`aori-ng-${t}`, AORI, `あおり ${TIER_NAME[t]} → 失敗`, (_host, tl) => aoriFlow(tl, t, false))),
  item('aori-fail', AORI, '失敗の音だけ', () => sfx.aoriFail()),
  item('aori-fail-3', AORI, '失敗の音を 3 回続けて（聞き飽きないか）', async (_host, tl) => {
    for (let i = 0; i < 3 && !tl.cancelled; i++) {
      sfx.aoriFail()
      await tl.wait(1500)
    }
  }),
  ...tiers.map((t) => item(`aori-start-${t}`, AORI, `始まりだけ（${TIER_NAME[t]}）`, () => sfx.aoriStart(t))),

  // モグラ・虹玉
  item('mole-appear', EVENT, 'モグラが顔を出す', () => sfx.moleAppear()),
  item('mole-dig', EVENT, 'モグラが掘る', () => sfx.moleDig()),
  item('mole-fill', EVENT, '穴を埋められた', () => sfx.moleFill()),
  item('mole-safe', EVENT, 'セーフ', () => sfx.moleSafe()),
  item('mole-flow-hit', EVENT, 'モグラの流れ（埋められた）', (_host, tl) => moleFlow(tl, true)),
  item('mole-flow-safe', EVENT, 'モグラの流れ（セーフ）', (_host, tl) => moleFlow(tl, false)),
  item('wild-ball', EVENT, '虹玉が出る', () => sfx.wildBall()),
  item('wild-open', EVENT, '虹玉でマスが開く', () => sfx.wildOpen()),

  // 景品パック
  ...glows.map(([g, name]) => item(`pack-${g}`, PACK, `パックが出る（${name}）`, () => sfx.packAppear(g))),
  item('pack-tear', PACK, 'パックを破る', () => sfx.packTear()),
  item('card-flip', PACK, 'カードがめくれる', () => sfx.cardFlip()),
  ...rarities.map(([r, name]) => item(`rarity-${r ?? 'ticket'}`, PACK, `レア度: ${name}`, () => sfx.rarity(r))),
  item('pack-flow-c', PACK, '開封の流れ（白 → C）', (_host, tl) => packFlow(tl, 'white', 'C')),
  item('pack-flow-fake', PACK, '開封の流れ（金のガセ → R）', (_host, tl) => packFlow(tl, 'gold', 'R')),
  item('pack-flow-sr', PACK, '開封の流れ（金 → SR）', (_host, tl) => packFlow(tl, 'gold', 'SR')),
  item('pack-flow-ur', PACK, '開封の流れ（虹 → UR）', (_host, tl) => packFlow(tl, 'rainbow', 'UR')),
  item('rank-up', PACK, 'ランクアップ', () => sfx.rankUp()),

  // 選択・上位チャレンジ
  item('countdown', CHOICE, '残り秒数（6 → 0）', (_host, tl) => countdownFlow(tl, 6)),
  item('choose-receive', CHOICE, '受け取る', () => sfx.choose('receive')),
  item('choose-challenge', CHOICE, '上位チャレンジ', () => sfx.choose('challenge')),
  item('challenge-deal', CHOICE, 'チャレンジのカードを配る', () => sfx.challengeDeal()),
  item('challenge-success', CHOICE, 'チャレンジ成功', () => sfx.challengeSuccess()),
  item('challenge-fail', CHOICE, 'チャレンジ失敗', () => sfx.challengeFail()),
  item('challenge-flow-ok', CHOICE, 'チャレンジの流れ（成功）', (_host, tl) => challengeFlow(tl, true)),
  item('challenge-flow-ng', CHOICE, 'チャレンジの流れ（失敗）', (_host, tl) => challengeFlow(tl, false)),
  item('last-one-win', CHOICE, 'ラストワン争奪（取れた）', () => sfx.lastOne(true)),
  item('last-one-lose', CHOICE, 'ラストワン争奪（取れなかった）', () => sfx.lastOne(false)),

  // ダブルチャンス（ガラポン）
  item('entry', DC, 'エントリー', () => sfx.entry()),
  item('garapon-taps', DC, 'ガラポン回転（連打 → 手を止める → 止める）', (host, tl) => garaponTaps(host, tl)),
  item('garapon-steps', DC, 'ガラポン回転（速さを段階で変える）', (host, tl) => garaponSteps(host, tl)),
  item('garapon-drop', DC, '玉が出る', () => sfx.garaponDrop()),
  item('garapon-win-red', DC, '当たりの鐘（赤）', () => sfx.garaponWin('red')),
  item('garapon-win-gold', DC, '当たりの鐘（金）', () => sfx.garaponWin('gold')),
  item('garapon-win-rainbow', DC, '当たりの鐘（虹）', () => sfx.garaponWin('rainbow')),
  item('garapon-miss', DC, 'はずれ', () => sfx.garaponMiss()),
  item('garapon-flow-gold', DC, '抽選の流れ（回す → 出る → 金）', (host, tl) => garaponFlow(host, tl, 'gold')),
  item('garapon-flow-miss', DC, '抽選の流れ（回す → 出る → はずれ）', (host, tl) => garaponFlow(host, tl, 'miss')),
  item('outro', DC, '締めくくり（おつかれさまでした）', () => sfx.outro()),
)
