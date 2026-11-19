import { registerGallery, type GalleryItem } from '../fx/gallery'
import { el, type Timeline } from '../fx/runtime'
import { engine, sfx } from './index'

// 緊急クエスト「モグラ撃退」の効果音のギャラリー（URL に ?gallery を付けると開く）。
// 1 つずつの音と、本番に近い流れ（警報 → たたき始め → 10 秒たたく → 残り 3・2・1 → 終わり → 結果）を登録する。
// 流れのモグラとたたく音は、人がたたくように時刻を揺らす（モグラは 1 秒に 3〜4 匹顔を出し、反応してたたく。ときどき空振り）。
// デモでは大画面とスマホの音が同じ PC から鳴るので、流れは両方を重ねて鳴らす（「スマホだけ」「大画面だけ」の流れも置く）。
// 画面には、音の名前と説明、いまの場面、残り秒数・たたいた数・連続を出す

type Cue = readonly [ms: number, fn: () => void]
type Tap = readonly [ms: number, kind: 'pop' | 'hit' | 'miss']

interface View {
  say(text: string): void
  stat(text: string): void
}

const GROUP = '音: 緊急クエスト'
const FLOW = '音: 緊急クエスト（流れ）'
const INTRO = 2600 // 警報の長さ（演出の introMs）
const PLAY = 10000 // たたける時間（演出の playMs）

function line(css: string, text = ''): HTMLDivElement {
  const node = el('div')
  node.style.cssText = css
  node.textContent = text
  return node
}

// 画面の真ん中に、音の名前と説明、いまの場面、たたいている様子（残り秒数・たたいた数・連続）を出す
function view(host: HTMLElement, title: string, note: string): View {
  const box = line(
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;' +
      "padding:0 160px;text-align:center;color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif",
  )
  const now = line('min-height:80px;font-size:60px;font-weight:900;color:#f5c542')
  const stat = line('min-height:56px;font-size:40px;font-weight:700;color:#8a93b8;font-variant-numeric:tabular-nums')
  box.append(
    line('font-size:84px;font-weight:900;letter-spacing:.02em', title),
    line('max-width:1500px;font-size:34px;line-height:1.6;color:#8a93b8', note),
    now,
    stat,
  )
  host.append(box)
  return {
    say(text) {
      now.textContent = text
    },
    stat(text) {
      stat.textContent = text
    },
  }
}

function item(id: string, label: string, note: string, play: (tl: Timeline, v: View) => Promise<void>, group = GROUP): GalleryItem {
  return {
    id: `sfx-quest-${id}`,
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

// たたく時間（from ms から len ms）に、モグラが顔を出す時刻と、それをたたく指の時刻。
// モグラは 1 秒に 3〜4 匹。skill（0〜1）が高いほど多く・速く当て、外したモグラのいくつかには空振りする
function taps(from: number, len: number, skill: number): Tap[] {
  const list: Tap[] = []
  for (let ms = from + 120; ms < from + len - 150; ms += 170 + Math.random() * (260 - 90 * skill)) {
    list.push([ms, 'pop'])
    const r = Math.random()
    const react = 230 + Math.random() * (420 - 200 * skill)
    if (r < 0.45 + 0.5 * skill) list.push([ms + react, 'hit'])
    else if (r < 0.75 + 0.2 * skill) list.push([ms + react * 0.8, 'miss'])
  }
  return list.filter(([ms]) => ms < from + len).sort((a, b) => a[0] - b[0])
}

interface Quest {
  stage: boolean // 大画面の音（警報・合図・残り秒数・終わり・結果）を鳴らす
  phone: boolean // スマホの音（ボス・モグラ・たたく音・自分の結果）を鳴らす
  target: boolean // 自分のリーチが狙われている（ボスモグラが出る）
  skill: number // 0〜1。高いほど多く当てる
  result: 'defend' | 'fail' | 'none' // スマホの結果（none は狙われていない人）
}

// 警報（2.6 秒）→ たたき始め → 10 秒たたく（残り 3・2・1）→ 終わり → 自分の結果 → 大画面の結果発表
function questFlow(tl: Timeline, v: View, q: Quest): Promise<void> {
  const cues: Cue[] = []
  const at = (ms: number, text: string, fn?: () => void): void => {
    cues.push([
      ms,
      () => {
        v.say(text)
        fn?.()
      },
    ])
  }
  let hits = 0
  let combo = 0
  let left = PLAY / 1000
  const show = (): void => v.stat(`残り ${left} 秒 ・ たたいた ${hits} 匹 ・ 連続 ${combo}`)

  at(0, '緊急クエスト発生！', q.stage ? sfx.questAlarm : undefined)
  if (q.target) at(1300, 'ボスモグラが、リーチのマスをねらってる！', q.phone ? sfx.bossAppear : undefined)
  const go = INTRO
  at(go, 'たたけ！', q.stage ? sfx.questGo : undefined)
  for (let s = PLAY / 1000; s >= 1; s--) {
    cues.push([
      go + PLAY - s * 1000,
      () => {
        left = s
        show()
        if (s > 3) return
        v.say(`残り ${s}`)
        if (q.stage) sfx.questTick(s)
      },
    ])
  }
  if (q.phone) {
    for (const [ms, kind] of taps(go, PLAY, q.skill)) {
      cues.push([
        ms,
        () => {
          if (kind === 'pop') return sfx.molePop()
          if (kind === 'hit') {
            hits++
            combo++
            sfx.whack(combo)
          } else {
            combo = 0
            sfx.whackMiss()
          }
          show()
        },
      ])
    }
  }
  const end = go + PLAY
  cues.push([
    end,
    () => {
      left = 0
      show()
      v.say('終了！')
      if (q.stage) sfx.questEnd()
    },
  ])
  let next = end + 1000
  if (q.phone && q.result === 'defend') {
    at(next, '守りきった！', sfx.questDefend)
    next += 1500
  }
  if (q.phone && q.result === 'fail') {
    at(next, '頑張ったけど、ダメだった…（あと 4 匹）', sfx.questFail)
    at(next + 1300, 'モグラが穴を埋めた（moleFill）', sfx.moleFill)
    next += 2400
  }
  if (q.stage) {
    at(next, '結果発表（撃退数の合計・撃退王）', sfx.questTally)
    next += 3600
  }
  return cue(tl, next + 300, cues)
}

registerGallery(
  // ---- 大画面 ------------------------------------------------------------------
  item(
    'alarm',
    'questAlarm 緊急クエスト発生',
    '約 2 秒。太鼓「ドドン！」とラの短調の金管「ジャン！」→ 中低音の警報「ウォン」×3（ラ・ラ・ド）。下で地鳴り「ゴゴゴ…」。甲高いサイレンにはしない',
    once(sfx.questAlarm, 3000),
  ),
  item(
    'go',
    'questGo たたき始め',
    '号砲「パン」と太鼓、ドの長調の金管「ジャーン」、駆け上がりと鐘（警報の短調から、晴れるように切り替わる）',
    once(sfx.questGo, 2000),
  ),
  item('alarm-go', 'questAlarm → questGo（2.6 秒後）', '本番の間隔（警報の長さ introMs = 2.6 秒）で、警報からたたき始めへ', (tl, v) =>
    cue(tl, 4800, [
      [0, sayAnd(v, '警報', sfx.questAlarm)],
      [INTRO, sayAnd(v, 'たたけ！', sfx.questGo)],
    ]),
  ),
  item(
    'tick',
    'questTick 残り 3・2・1 → questEnd',
    '木の「カッ」と、上がっていく「ポーン」（ミ → ソ → ラ）、胸に響く「ドン」（残りが少ないほど強く）。0 で終わりのゴング',
    (tl, v) =>
      cue(tl, 4800, [
        ...[3, 2, 1].map((s, i): Cue => [i * 1000, sayAnd(v, `残り ${s}`, () => sfx.questTick(s))]),
        [3000, sayAnd(v, '終了！', sfx.questEnd)],
      ]),
  ),
  item('tick-long', 'questTick 残り 5 秒から', '4 秒以上は小さな「カチ」だけ。3 秒から音程の付いた音になる', (tl, v) =>
    cue(
      tl,
      5600,
      [5, 4, 3, 2, 1].map((s, i): Cue => [i * 1000, sayAnd(v, `残り ${s}`, () => sfx.questTick(s))]),
    ),
  ),
  item(
    'end',
    'questEnd 終わり',
    '試合終了のゴング「カン・カン・カーン」と太鼓。モグラが穴へ引っ込んでいく「シュルル」',
    once(sfx.questEnd, 2200),
  ),
  item(
    'tally',
    'questTally 結果の数え上げ',
    'スネアのロールと「チチチ…」の駆け上がり（1.5 秒）→ 1.5 秒で「ジャッ」、1.66 秒で「ジャーン！」。撃退王の「キラリーン」で締める',
    once(sfx.questTally, 4200),
  ),

  // ---- スマホ ------------------------------------------------------------------
  item('pop-each', 'molePop 1 匹ずつ', '「ぴょこっ」。高さは五音音階（ソ ラ ド レ ミ）から毎回選ぶ', (tl) =>
    cue(
      tl,
      2600,
      Array.from({ length: 5 }, (_, i): Cue => [i * 420, () => sfx.molePop()]),
    ),
  ),
  item('pop-run', 'molePop 続けて（1 秒に 4 匹）', '1 秒に数回鳴っても軽く、ころころした旋律に聞こえる', (tl) =>
    cue(
      tl,
      3600,
      Array.from({ length: 12 }, (_, i): Cue => [Math.round(i * 250 + Math.random() * 80), () => sfx.molePop()]),
    ),
  ),
  item(
    'whack-combo',
    'whack 連続 1 → 14（1 秒に 4 回）',
    '「ポコッ」。続けて当てるほど「ピコッ」が五音音階を上がり（ド → 上のミ。その先はレ・ミを行き来）、明るく「キラッ」と光る',
    (tl, v) =>
      cue(
        tl,
        4300,
        Array.from({ length: 14 }, (_, i): Cue => [i * 260, sayAnd(v, `連続 ${i + 1}`, () => sfx.whack(i + 1))]),
      ),
  ),
  item('whack-each', 'whack 1 打ずつ（連続 1・4・8・12）', '1 打の中身を聞く（それぞれ 2 打ずつ）', (tl, v) =>
    cue(
      tl,
      4000,
      [1, 4, 8, 12].flatMap((c, i) => [0, 1].map((j): Cue => [i * 850 + j * 300, sayAnd(v, `連続 ${c}`, () => sfx.whack(c))])),
    ),
  ),
  item('whack-fast', 'whack 速い連打（1 秒に 10 回）', '速くたたくほど 1 打を小さくするので、続けても全体が大きくならない', (tl, v) =>
    cue(
      tl,
      3400,
      Array.from({ length: 30 }, (_, i): Cue => [Math.round(i * 100 + Math.random() * 20), sayAnd(v, `連続 ${i + 1}`, () => sfx.whack(i + 1))]),
    ),
  ),
  item('miss', 'whackMiss 空振り', 'ごく控えめな「スカッ」（音程なし）', (tl) =>
    cue(tl, 1800, [0, 450, 900].map((ms): Cue => [ms, () => sfx.whackMiss()])),
  ),
  item('whack-miss', 'whack と whackMiss をまぜる', '当たり 3 回 → 空振り（連続が切れる）→ 当たり 3 回', (tl, v) => {
    let combo = 0
    const seq = ['hit', 'hit', 'hit', 'miss', 'hit', 'hit', 'hit'] as const
    return cue(
      tl,
      2800,
      seq.map((kind, i): Cue => [
        i * 300,
        () => {
          if (kind === 'miss') {
            combo = 0
            v.say('空振り')
            sfx.whackMiss()
            return
          }
          combo++
          v.say(`連続 ${combo}`)
          sfx.whack(combo)
        },
      ]),
    )
  }),
  item(
    'boss',
    'bossAppear ボスモグラ',
    'ねらわれた人だけ。地鳴り「ゴゴゴ…」→ 0.42 秒で「ドバッ！」とラの短調の金管 → 照準の「ピピッ」→ 低い唸り「グルル…」',
    once(sfx.bossAppear, 2200),
  ),
  item('defend', 'questDefend 守りきった', '盾がはじく「カキーン！」と、短い金管「パ・パーン」、駆け上がるきらきら', once(sfx.questDefend, 2000)),
  item(
    'fail',
    'questFail 頑張ったけどダメだった',
    '「ストン…ポロロロン」とラまで駆け下り、こもりながら少し下がる和音（ラ ド ミ ソ）。悔しいが重すぎない',
    once(sfx.questFail, 2200),
  ),
  item('fail-fill', 'questFail → moleFill（1.3 秒後）', '本番の順: ダメだった → モグラが穴を埋める（moleFill はイベントの音）', (tl, v) =>
    cue(tl, 3300, [
      [0, sayAnd(v, 'ダメだった…', sfx.questFail)],
      [1300, sayAnd(v, '穴を埋められた', sfx.moleFill)],
    ]),
  ),

  // ---- 流れ（本番に近い順番と間隔） -------------------------------------------
  item(
    'flow-defend',
    'ねらわれた人: 守りきった',
    '大画面とスマホを重ねて鳴らす（デモと同じ）。警報 → ボス → たたき始め → 10 秒たたく → 3・2・1 → 終わり → 守りきった → 結果発表',
    (tl, v) => questFlow(tl, v, { stage: true, phone: true, target: true, skill: 0.85, result: 'defend' }),
    FLOW,
  ),
  item(
    'flow-fail',
    'ねらわれた人: ダメだった',
    'あまり当てられない人。終わったあと「頑張ったけどダメだった」→ 穴を埋められる → 結果発表',
    (tl, v) => questFlow(tl, v, { stage: true, phone: true, target: true, skill: 0.25, result: 'fail' }),
    FLOW,
  ),
  item(
    'flow-free',
    'ねらわれていない人',
    'ボスは出ないが、たたいた数は会場の合計と撃退王に入る。自分の結果の音はなし',
    (tl, v) => questFlow(tl, v, { stage: true, phone: true, target: false, skill: 0.6, result: 'none' }),
    FLOW,
  ),
  item(
    'flow-phone',
    'スマホだけ（ねらわれた人・守りきった）',
    '大画面の音を外して、スマホで鳴る音（ボス・モグラ・たたく音・結果）だけを聞く',
    (tl, v) => questFlow(tl, v, { stage: false, phone: true, target: true, skill: 0.7, result: 'defend' }),
    FLOW,
  ),
  item(
    'flow-stage',
    '大画面だけ',
    'スマホの音を外して、大画面の音（警報・たたき始め・3・2・1・終わり・結果発表）だけを聞く',
    (tl, v) => questFlow(tl, v, { stage: true, phone: false, target: false, skill: 0, result: 'none' }),
    FLOW,
  ),
)
