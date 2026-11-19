import type { Tier } from '../fx/theme'
import { registerGallery, type GalleryItem } from '../fx/gallery'
import { el, type Timeline } from '../fx/runtime'
import { engine, sfx } from './index'

// オリパのお約束の合図（「プチュン」・復活）の効果音のギャラリー（URL に ?gallery を付けると開く）。
// 1 つずつの音と、本番に近い流れ（プチュン → 暗転（約 0.5 秒）→ 復活 → aoriSuccess（赤・金・虹））を登録する。
// 画面には、音の名前と説明、いまの場面を出す。暗転のあいだは画面も暗くする

type Cue = readonly [ms: number, fn: () => void]

interface View {
  say(text: string): void
  dark(on: boolean): void
}

const GROUP = '音: オリパの合図'
const FLOW = '音: オリパの合図（流れ）'
const CUT = 300 // puchun の音が切れる時刻（ここで画面を落とす）
const DARK = 850 // puchun を鳴らしてから revive まで（puchun 0.35 秒 ＋ 暗転 0.5 秒）
const REVIVE = 1000 // revive を鳴らしてから aoriSuccess まで
const TIER_NAME: Readonly<Record<Tier, string>> = { 0: '青', 1: '緑', 2: '赤', 3: '金', 4: '虹' }

function line(css: string, text = ''): HTMLDivElement {
  const node = el('div')
  node.style.cssText = css
  node.textContent = text
  return node
}

// 画面の真ん中に、音の名前と説明、いまの場面を出す。dark で全体を暗転させる
function view(host: HTMLElement, title: string, note: string): View {
  const box = line(
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;' +
      "padding:0 160px;text-align:center;color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif",
  )
  const now = line('min-height:80px;font-size:60px;font-weight:900;color:#f5c542')
  const shade = line('position:absolute;inset:0;background:#000;opacity:0;pointer-events:none')
  box.append(
    line('font-size:84px;font-weight:900;letter-spacing:.02em', title),
    line('max-width:1500px;font-size:34px;line-height:1.6;color:#8a93b8', note),
    now,
  )
  host.append(box, shade)
  return {
    say(text) {
      now.textContent = text
    },
    dark(on) {
      shade.style.opacity = on ? '1' : '0'
    },
  }
}

function item(id: string, label: string, note: string, play: (tl: Timeline, v: View) => Promise<void>, group = GROUP): GalleryItem {
  return {
    id: `sfx-oripa-${id}`,
    group,
    label,
    screen: 'sound',
    play(host, tl) {
      // 前の見本の伸ばす音と、BGM の下げを片づける
      sfx.silence()
      engine.duckBgm(1, 100)
      return play(tl, view(host, label, note))
    },
  }
}

// 予定の時刻（演出上の ms）に鳴らして、total ms 待つ。速度の切り替えと取り消しは Timeline に任せる
function cue(tl: Timeline, total: number, events: readonly Cue[]): Promise<void> {
  for (const [ms, fn] of events) tl.at(ms, fn)
  return tl.wait(total)
}

const once = (fn: () => void, total: number) => (tl: Timeline) => cue(tl, total, [[0, fn]])

// いまの場面の文字を出してから鳴らす
const sayAnd =
  (v: View, text: string, fn: () => void) =>
  (): void => {
    v.say(text)
    fn()
  }

// プチュン → 暗転 → 復活 → 成功。from はプチュンを鳴らす時刻
function reviveCues(v: View, from: number, tier: Tier): Cue[] {
  return [
    [from, sayAnd(v, 'プチュン', sfx.puchun)],
    [from + CUT, () => v.dark(true)],
    [
      from + DARK,
      () => {
        v.dark(false)
        v.say('復活！')
        sfx.revive()
      },
    ],
    [from + DARK + REVIVE, sayAnd(v, `成功（aoriSuccess ${TIER_NAME[tier]}）`, () => sfx.aoriSuccess(tier))],
  ]
}

registerGallery(
  // ---- 1 つずつ -----------------------------------------------------------------
  item(
    'puchun',
    'puchun「プチュン」',
    '0.33 秒。「プ」→ 0.05 秒で「チュ」→ 高い音が落ちながらこもり、0.30 秒で電源を抜いたように切れる。残響なしで、そのあとは無音',
    (tl, v) =>
      cue(tl, 1600, [
        [0, sayAnd(v, 'プチュン', sfx.puchun)],
        [CUT, () => v.dark(true)],
        [1100, () => v.dark(false)],
      ]),
  ),
  item(
    'revive',
    'revive 復活',
    '1.0 秒。底を蹴る「ドゥ」から一気に駆け上がり、0.40 秒で「パァン！」と弾ける。ソの和音（ソ ド レ）のまま、解決せずに終わる',
    once(sfx.revive, 2400),
  ),
  item('revive-success', 'revive → aoriSuccess 金（1.0 秒後）', '復活のソの和音を、成功のドの和音が受け止める', (tl, v) =>
    cue(tl, 3600, [
      [0, sayAnd(v, '復活！', sfx.revive)],
      [REVIVE, sayAnd(v, '成功（aoriSuccess 金）', () => sfx.aoriSuccess(3))],
    ]),
  ),

  // ---- 流れ: プチュン → 復活 -----------------------------------------------------
  ...([2, 3, 4] as const).map((tier) =>
    item(
      `revive-${tier}`,
      `プチュン → 暗転 → 復活 → 成功（${TIER_NAME[tier]}）`,
      `プチュン（0.30 秒で音が切れて暗転）→ 0.85 秒後に復活 → その 1.0 秒後に aoriSuccess（${TIER_NAME[tier]}）`,
      (tl, v) => cue(tl, tier === 4 ? 5200 : 4200, reviveCues(v, 0, tier)),
      FLOW,
    ),
  ),
  item(
    'fake-out',
    '赤のあおり → 外れに見えて → プチュン → 復活（金）',
    '手元のあおり（赤）が高まったところで、プチュンと切れる。暗転のあと、復活して金の成功へ',
    (tl, v) =>
      cue(tl, 6600, [
        [0, sayAnd(v, 'あおり（赤）', () => sfx.aoriStart(2))],
        ...[800, 1300, 1800].map((ms): Cue => [ms, () => sfx.aoriPulse(2)]),
        ...reviveCues(v, 2300, 3),
      ]),
    FLOW,
  ),
)
