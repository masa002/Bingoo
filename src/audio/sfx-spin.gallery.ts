import { registerGallery, type GalleryItem } from '../fx/gallery'
import { el, type Timeline } from '../fx/runtime'
import { RAINBOW, TIER_COLOR, TIER_NAME, TIER_SHAPE, type Tier } from '../fx/theme'
import { engine, sfx } from './index'

// 手元のスロットの効果音のギャラリー（URL に ?gallery を付けると開く）。
// 1 つずつの音と、本番に近い「回り出す → 連打 → 段階が上がる → STOP → 着地」の流れを登録する。
// 流れの連打は人の指のように間隔を揺らし（1 秒に 12 回前後、ときどき一息つく）、1 打ごとにゲージ（power）を溜める。
// 画面には、音の名前と説明、いまの場面、ゲージ（段階の色・形・名前）と STOP の状態を出す

type Cue = readonly [ms: number, fn: () => void]
type StopState = 'off' | 'ready' | 'pressed'

interface View {
  say(text: string): void
  gauge(power: number, tier: Tier): void
  stop(state: StopState): void
}

const GROUP = '音: 手元のスロット'
const FLOW = '音: 手元のスロット（流れ）'
const TIERS: readonly Tier[] = [0, 1, 2, 3, 4]
const FULL = 34 // ゲージが満タンになるまでの打数（1 秒に 12 回なら 3 秒ほど）
const RAINBOW_BAR = `linear-gradient(90deg, ${RAINBOW.join(', ')})`
const STOP_STYLE: Readonly<Record<StopState, string>> = {
  off: 'background:transparent;color:#4a5378;border-color:#2b3a7a',
  ready: 'background:#f5c542;color:#1a1400;border-color:#f5c542',
  pressed: 'background:#8a93b8;color:#141c40;border-color:#8a93b8',
}

function line(css: string, text = ''): HTMLDivElement {
  const node = el('div')
  node.style.cssText = css
  node.textContent = text
  return node
}

// 画面の真ん中に、音の名前と説明、いまの場面を出す。gauge なら、その下にゲージと STOP を並べる
function view(host: HTMLElement, title: string, note: string, gauge: boolean): View {
  const box = line(
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;' +
      "padding:0 160px;text-align:center;color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif",
  )
  const now = line('min-height:80px;font-size:60px;font-weight:900;color:#f5c542')
  box.append(line('font-size:84px;font-weight:900;letter-spacing:.02em', title), line('max-width:1500px;font-size:34px;line-height:1.6;color:#8a93b8', note), now)
  host.append(box)
  const say = (text: string): void => {
    now.textContent = text
  }
  if (!gauge) return { say, gauge() {}, stop() {} }
  const label = line('width:200px;text-align:right;font-size:44px;font-weight:900')
  const bar = line('position:relative;width:960px;height:44px;border-radius:22px;overflow:hidden;background:#141c40;box-shadow:inset 0 0 0 3px #2b3a7a')
  const fill = line('position:absolute;left:0;top:0;bottom:0;width:0;transition:width 60ms linear')
  bar.append(fill, ...[25, 50, 75].map((x) => line(`position:absolute;top:0;bottom:0;left:${x}%;width:4px;background:#05070f`)))
  const stop = line('', 'STOP')
  const row = line('display:flex;align-items:center;gap:32px;margin-top:12px')
  row.append(label, bar, stop)
  box.append(row)
  const v: View = {
    say,
    gauge(power, tier) {
      fill.style.width = `${(Math.min(1, Math.max(0, power)) * 100).toFixed(1)}%`
      fill.style.background = tier === 4 ? RAINBOW_BAR : TIER_COLOR[tier]
      label.textContent = `${TIER_SHAPE[tier]} ${TIER_NAME[tier]}`
      label.style.color = tier === 4 ? '#ffffff' : TIER_COLOR[tier]
    },
    stop(state) {
      stop.style.cssText =
        'width:240px;padding:10px 0;border-radius:44px;border:4px solid;font-size:44px;font-weight:900;letter-spacing:.08em;' + STOP_STYLE[state]
    },
  }
  v.gauge(0, 0)
  v.stop('off')
  return v
}

function item(
  id: string,
  label: string,
  note: string,
  play: (tl: Timeline, v: View) => Promise<void>,
  o: { group?: string; gauge?: boolean } = {},
): GalleryItem {
  return {
    id: `sfx-spin-${id}`,
    group: o.group ?? GROUP,
    label,
    screen: 'sound',
    play(host, tl) {
      // 前の見本の伸ばす音と、BGM の下げを片づける
      sfx.silence()
      engine.duckBgm(1, 100)
      return play(tl, view(host, label, note, o.gauge ?? false))
    },
  }
}

// 予定の時刻（演出上の ms）に鳴らして、total ms 待つ。速度の切り替えと取り消しは Timeline に任せる
function cue(tl: Timeline, total: number, events: readonly Cue[]): Promise<void> {
  for (const [ms, fn] of events) tl.at(ms, fn)
  return tl.wait(total)
}

const once = (fn: () => void, total: number) => (tl: Timeline) => cue(tl, total, [[0, fn]])

// 人の指の連打の時刻（ms）。最初の数打はゆっくり、あとは 1 秒に 12 回前後で間隔を揺らし、ときどき一息つく
function tapTimes(from: number, count: number): number[] {
  const list: number[] = []
  let ms = from
  for (let i = 0; i < count; i++) {
    list.push(Math.round(ms))
    ms += i < 4 ? 170 - i * 25 : 62 + Math.random() * 38
    if (i > 8 && Math.random() < 0.07) ms += 120 + Math.random() * 140
  }
  return list
}

interface Plan {
  tiers: readonly Tier[] // level 1〜4 で出る予告の格
  land: Tier // 着地の段階
  confirm?: boolean // 虹の確定: 初めて虹になった段で、演出側の aoriStart(4) を重ねる
  auto?: boolean // STOP を押さずに、時間切れで止まる
}

// 回り出す → 連打（満タンのあとも少し続ける）→ 段階が上がるたびに予告 → STOP が光る → 押す → 減速 → 着地
function spinFlow(tl: Timeline, v: View, plan: Plan): Promise<void> {
  const cues: Cue[] = [
    [
      0,
      () => {
        v.say('回り出す')
        sfx.spinStart()
      },
    ],
  ]
  const times = tapTimes(650, FULL + 4)
  let level = 0
  let full = 0
  times.forEach((ms, i) => {
    const power = Math.min(1, (i + 1) / FULL)
    const lv = Math.min(4, Math.floor(power * 4 + 1e-9))
    const tier = lv > 0 ? plan.tiers[lv - 1] : 0
    const up = lv > level
    const confirm = up && plan.confirm === true && tier === 4 && (lv === 1 || plan.tiers[lv - 2] !== 4)
    level = lv
    if (up && lv === 4) full = ms
    cues.push([
      ms,
      () => {
        sfx.spinTap(power)
        v.gauge(power, tier)
        if (!up) return
        v.say(`段階 ${lv}：${TIER_SHAPE[tier]} ${TIER_NAME[tier]}${confirm ? '（確定！ ＋ aoriStart(4)）' : ''}`)
        sfx.spinLevel(lv, tier)
        if (confirm) sfx.aoriStart(4)
      },
    ])
  })
  const ready = full + 200
  cues.push([
    ready,
    () => {
      v.say('STOP が押せる')
      v.stop('ready')
      sfx.stopReady()
    },
  ])
  const lastTap = times[times.length - 1]
  if (plan.auto) {
    const land = Math.max(lastTap, ready) + 1800
    cues.push([
      land,
      () => {
        v.say(`時間切れで止まる（${TIER_SHAPE[plan.land]} ${TIER_NAME[plan.land]}）`)
        v.stop('off')
        sfx.reelLand(plan.land)
      },
    ])
    return cue(tl, land + 1900, cues)
  }
  // 確定（虹）のときは、確定の演出を見せてから押す
  const press = Math.max(lastTap + 420, ready + (plan.confirm ? 1900 : 520))
  const land = press + 650
  cues.push([
    press,
    () => {
      v.say('STOP！')
      v.stop('pressed')
      sfx.stopPress()
    },
  ])
  cues.push([
    land,
    () => {
      v.say(`着地（${TIER_SHAPE[plan.land]} ${TIER_NAME[plan.land]}）`)
      sfx.reelLand(plan.land)
    },
  ])
  return cue(tl, land + (plan.land >= 3 ? 2600 : 1900), cues)
}

const LEVEL_NOTE: Readonly<Record<Tier, string>> = {
  0: '青: 小さな「ポロン」（2 音だけ、控えめ）。level ごとに ド・レ・ミ・ソ と上がる',
  1: '緑: 「ピロリン」（3 音の駆け上がり＋小さな鐘ときらめき）',
  2: '赤: 速い駆け上がりで吸い込んで「ジャン！」（低いドン＋短い金管の和音）',
  3: '金: シャララ → 低いドン＋鐘の和音・金管・軽いシンバル・きらきら',
  4: '虹: 左右いっぱいのグリッサンド → 鐘・金管・パッド、光が上へ抜ける（確定の音は演出側の aoriStart(4) が受け持つ）',
}
const LAND_NOTE: Readonly<Record<Tier, string>> = {
  0: '青: 「ガチッ」＋小さな「ポン」（いちばんよく鳴る音）',
  1: '緑: 「ガチッ」＋「ポン」＋ド・ソのはじく音',
  2: '赤: 低音のドロップと雑音の割れ、鐘（ド・ソ）',
  3: '金: さらに重く、軽いシンバルと鐘の和音（ド ミ ソ ド）、きらきら',
  4: '虹: 金に、虹のグリッサンドとパッドを重ねる（どの段階も大画面の impact よりは小さい）',
}

registerGallery(
  // ---- 1 つずつ --------------------------------------------------------------
  item('start', 'spinStart 回り出す', 'レバーの「カチャッ」→ モーターの「ウィーン」と風切り。コマ送りが速くなって「キラッ」', once(sfx.spinStart, 1300)),
  item(
    'tap-run',
    'spinTap 連打（power 0 → 1）',
    '1 秒に 12 回前後の連打。ゲージが溜まるほど「ポ」が五音音階を上がり（ミ → 上のミ）、明るい「ピッ」になる',
    (tl, v) => {
      const times = tapTimes(300, 46)
      return cue(
        tl,
        times[times.length - 1] + 700,
        times.map((ms, i): Cue => {
          const power = i / (times.length - 1)
          return [
            ms,
            () => {
              v.say(`power ${power.toFixed(2)}`)
              v.gauge(power, 0)
              sfx.spinTap(power)
            },
          ]
        }),
      )
    },
    { gauge: true },
  ),
  item(
    'tap-each',
    'spinTap 1 打ずつ（power 0・0.25・0.5・0.75・1）',
    '1 打の中身を聞く（それぞれ 3 打ずつ）',
    (tl, v) =>
      cue(
        tl,
        4800,
        [0, 0.25, 0.5, 0.75, 1].flatMap((power, i) =>
          [0, 1, 2].map((j): Cue => [
            i * 900 + j * 230,
            () => {
              v.say(`power ${power}`)
              v.gauge(power, 0)
              sfx.spinTap(power)
            },
          ]),
        ),
      ),
    { gauge: true },
  ),
  item('tap-fast', 'spinTap 速い連打（16 回/秒・power 1）', '速く連打しても大きくならない（速いほど 1 打を小さくする）', (tl) =>
    cue(tl, 2500, Array.from({ length: 32 }, (_, i): Cue => [i * 62, () => sfx.spinTap(1)])),
  ),
  ...TIERS.map((t) =>
    item(
      `level-${t}`,
      `spinLevel ${TIER_NAME[t]}（level 1 → 4）`,
      LEVEL_NOTE[t],
      (tl, v) =>
        cue(
          tl,
          4200,
          [1, 2, 3, 4].map((lv): Cue => [
            (lv - 1) * 850 + 200,
            () => {
              v.say(`level ${lv}`)
              v.gauge(lv / 4, t)
              sfx.spinLevel(lv, t)
            },
          ]),
        ),
      { gauge: true },
    ),
  ),
  item(
    'level-compare',
    'spinLevel 格くらべ（level 3 で 青 → 虹）',
    '同じ段で、予告の格だけを変える。青は控えめ、緑・赤・金と強くなり、虹がいちばん広い',
    (tl, v) =>
      cue(
        tl,
        6600,
        TIERS.map((t, i): Cue => [
          i * 1250 + 200,
          () => {
            v.say(`${TIER_SHAPE[t]} ${TIER_NAME[t]}`)
            v.gauge(0.75, t)
            sfx.spinLevel(3, t)
          },
        ]),
      ),
    { gauge: true },
  ),
  item(
    'ready',
    'stopReady STOP が押せる',
    '光が走る「シュッ」＋「カチャッ」＋高い「ピコーン」（ソ → 上のド）。連打の「ポ」より高く、短い',
    once(sfx.stopReady, 1200),
  ),
  item(
    'press',
    'stopPress STOP を押す',
    'ボタンの「カチッ・コッ」と低い「ドッ」→ ブレーキ「キュウゥン」→ コマ送りが遅くなっていく（着地が来ないときの全体）',
    once(sfx.stopPress, 1500),
  ),
  item('press-land', 'stopPress → reelLand（0.35 秒で着地）', '減速の途中で着地が来たら、残りのコマ送りはそこで止まる', (tl) =>
    cue(tl, 2000, [
      [0, sfx.stopPress],
      [350, () => sfx.reelLand(0)],
    ]),
  ),
  ...TIERS.map((t) => item(`land-${t}`, `reelLand ${TIER_NAME[t]}`, LAND_NOTE[t], once(() => sfx.reelLand(t), t >= 2 ? 2600 : 1500))),

  // ---- 流れ（本番に近い順番と間隔） -------------------------------------------
  item('flow-blue', '青: 連打 → STOP → 着地', 'いちばんよくある流れ。段階の音はずっと青（ポロン）で、ド・レ・ミ・ソ と上がる', (tl, v) =>
    spinFlow(tl, v, { tiers: [0, 0, 0, 0], land: 0 }), { group: FLOW, gauge: true },
  ),
  item('flow-green', '緑: 青 → 緑', '段階 3 から緑の予告（ピロリン）', (tl, v) => spinFlow(tl, v, { tiers: [0, 0, 1, 1], land: 1 }), {
    group: FLOW,
    gauge: true,
  }),
  item('flow-red', '赤: 青 → 緑 → 赤', '満タンで赤（ジャン！）。着地は低音のドロップと鐘', (tl, v) => spinFlow(tl, v, { tiers: [0, 1, 1, 2], land: 2 }), {
    group: FLOW,
    gauge: true,
  }),
  item('flow-gold', '金: 青 → 緑 → 赤 → 金', '段階ごとに格が上がる。満タンで金（シャララ → 鐘）', (tl, v) => spinFlow(tl, v, { tiers: [0, 1, 2, 3], land: 3 }), {
    group: FLOW,
    gauge: true,
  }),
  item(
    'flow-rainbow',
    '虹: 緑 → 赤 → 金 → 虹（確定）',
    '虹になった段で、演出側の aoriStart(4)（確定）が重なる。確定を見せてから STOP',
    (tl, v) => spinFlow(tl, v, { tiers: [1, 2, 3, 4], land: 4, confirm: true }),
    { group: FLOW, gauge: true },
  ),
  item(
    'flow-auto',
    '時間切れ: STOP を押さずに止まる',
    'STOP が光ったあと押さずにいると、ブレーキの音なしで着地する',
    (tl, v) => spinFlow(tl, v, { tiers: [0, 0, 1, 1], land: 1, auto: true }),
    { group: FLOW, gauge: true },
  ),
)
