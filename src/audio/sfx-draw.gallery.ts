import { registerGallery, type GalleryItem } from '../fx/gallery'
import type { Timeline } from '../fx/runtime'
import { TIER_NAME, type Tier } from '../fx/theme'
import { engine } from './engine'
import { drawSfx as sfx } from './sfx-draw'

// 抽選まわりの効果音のギャラリー（URL に ?gallery を付けると開く）。
// 1 つずつの音と、本番に近い順で並べた「流れ」を登録する。伸ばす音（ライザー・鼓動）は数秒で止める見本にする。
// 大画面の抽選機が鳴らすのは、コマ送り（tick）と着地（impact の 0〜2。結果で強さを選ぶ）だけ。
// 期待度の予告の音（色が上がる・ステップ・群れ・止まりかけ・ライザー・鼓動・金の粒・合図待ち）は、
// 大画面から期待度をなくしたので、いまはどの画面も鳴らしていない（音は残してあるので、別の組に分けて並べる）

type Say = (text: string) => void
type Cue = readonly [ms: number, fn: () => void]

const GROUP = '音: 抽選'
const FLOW = '音: 抽選（流れ）'
const UNUSED = '音: 抽選（いまは使っていない）'
// 大画面では鳴らさなくなったが、スマホの予告（自分の期待度）で鳴らす音
const PHONE = '音: スマホの予告'

// 画面の真ん中に、音の名前と説明、いま鳴っている場面を出す
function caption(host: HTMLElement, title: string, note: string): Say {
  const box = document.createElement('div')
  box.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;' +
    'padding:0 160px;text-align:center;color:#e8ecff;font-family:"Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif'
  const h = document.createElement('div')
  h.style.cssText = 'font-size:84px;font-weight:900;letter-spacing:.02em'
  h.textContent = title
  const p = document.createElement('div')
  p.style.cssText = 'max-width:1500px;font-size:34px;line-height:1.6;color:#8a93b8'
  p.textContent = note
  const now = document.createElement('div')
  now.style.cssText = 'min-height:80px;font-size:60px;font-weight:900;color:#f5c542'
  box.append(h, p, now)
  host.append(box)
  return (text) => {
    now.textContent = text
  }
}

// 前の見本の伸ばす音と、BGM の下げを片づける
function reset(): void {
  sfx.silence()
  engine.duckBgm(1, 100)
}

function item(id: string, label: string, note: string, play: (tl: Timeline, say: Say) => Promise<void>, group = GROUP): GalleryItem {
  return {
    id: `sfx-draw-${id}`,
    group,
    label,
    screen: 'sound',
    play(host, tl) {
      reset()
      return play(tl, caption(host, label, note))
    },
  }
}

// 予定の時刻（演出上の ms）に鳴らして、total ms 待つ。速度の切り替えと取り消しは Timeline に任せる
function cue(tl: Timeline, total: number, events: readonly Cue[]): Promise<void> {
  for (const [ms, fn] of events) tl.at(ms, fn)
  return tl.wait(total)
}

// リールのコマ送り（from ms から len ms のあいだ、interval ms ごとに tick）
function reel(tl: Timeline, from: number, len: number, interval: number): void {
  for (let x = 0; x < len; x += interval) tl.at(from + x, () => sfx.tick())
}

const once = (fn: () => void, total: number) => (tl: Timeline) => cue(tl, total, [[0, fn]])

const CUTIN_NOTE = ['', '緑: シャキーン＋明るい和音', '赤: ドォン＋歪んだ低い和音＋シンバル', '金: ジャーン＋豊かな和音・鐘・きらきら']
// 大画面の抽選機は、着地の強さ（結果）で 0〜2 を選ぶ: 0 何もなし / 1 リーチが増えた / 2 ビンゴが出た
const STAGE_LAND = ['何もなし', 'リーチが増えた', 'ビンゴが出た'] as const
const IMPACT_NOTE = [
  '軽い「ポン」（いちばんよく鳴る音）。大画面の着地: 何もなし',
  'ポォン＋キラッ。大画面の着地: リーチが増えた',
  '低音のドロップ・雑音のクラック・鐘。大画面の着地: ビンゴが出た（このあと、人数に応じたファンファーレが鳴る）',
  '以前の金の着地: さらに重く、シンバルと鐘の和音、長いきらきら',
  '以前の虹の着地: 金に、虹のグリッサンドとパッドを重ねる',
]
const FANFARE_NOTE = {
  small: 'タタ・ターン（1〜数人）',
  medium: 'タタタ・ターン・タ・ターン',
  big: '最後に ♭VI・♭VII・I（ジャン・ジャン・ジャーーン）で締める',
} as const

registerGallery(
  // ---- 1 つずつ --------------------------------------------------------------
  item('uitap', 'uiTap ボタン', 'ボタンを押したときの小さく丸い音（3 回）', (tl) =>
    cue(tl, 1200, [
      [0, sfx.uiTap],
      [380, sfx.uiTap],
      [760, sfx.uiTap],
    ]),
  ),
  item('tick', 'tick コマ送り', 'リールが回る音。何十回鳴っても疲れない小ささ。最後は減速して止まる', (tl) => {
    const events: Cue[] = []
    let ms = 0
    for (let i = 0; i < 40; i++, ms += 55) events.push([ms, sfx.tick])
    for (let i = 0; i < 9; i++) {
      ms += 70 + i * 30
      events.push([ms, sfx.tick])
    }
    return cue(tl, ms + 300, events)
  }),
  ...([1, 2, 3, 4] as const).map((t) =>
    item(`hold-${t}`, `holdChange ${TIER_NAME[t]}`, '色が上がった合図', once(() => sfx.holdChange(t), 1800), UNUSED),
  ),
  item('step', 'step ステップアップ（5 段）', '段ごとに音階が上がり、段階の色（青→緑→赤→金）で音色が厚くなる', (tl, say) => {
    const tiers: Tier[] = [0, 1, 2, 3, 3]
    reel(tl, 0, 3200, 55)
    return cue(
      tl,
      3800,
      tiers.map((tier, i): Cue => [
        300 + i * 600,
        () => {
          say(`STEP ${i + 1}（${TIER_NAME[tier]}）`)
          sfx.step(i, tier)
        },
      ]),
    )
  }, UNUSED),
  item('flutter', 'flutter 群予告', 'カードの群れが左から右へ横切る（シュッ・バサバサ）', once(sfx.flutter, 1500), PHONE),
  item('pseudo', 'pseudoStop → nextChime 疑似連（3 回）', '止まりかけ…「NEXT」で回り直す。続くほどチャイムが高くなる', (tl, say) => {
    const events: Cue[] = []
    reel(tl, 0, 400, 55)
    for (let i = 0; i < 3; i++) {
      const at = 400 + i * 900
      reel(tl, at, 380, 170) // 止まりかける
      events.push([
        at + 380,
        () => {
          say(`疑似 ${i + 1}…`)
          sfx.pseudoStop()
        },
      ])
      events.push([
        at + 560,
        () => {
          say(`NEXT ×${i + 1}`)
          sfx.nextChime()
        },
      ])
      reel(tl, at + 780, i < 2 ? 520 : 900, 55)
    }
    return cue(tl, 3800, events)
  }, PHONE),
  ...([1, 2, 3] as const).map((t) => item(`cutin-${t}`, `cutin ${TIER_NAME[t]}`, CUTIN_NOTE[t], once(() => sfx.cutin(t), 2200))),
  item('telop', 'telop テロップ', '控えめな「スッ」と、やわらかい 2 音', once(sfx.telop, 1200)),
  item('riser', 'riser ライザー → silence', '2.5 秒上がり続けて、silence() でピタッと止める', (tl, say) =>
    cue(tl, 3400, [
      [
        0,
        () => {
          say('riser(2.5)')
          sfx.riser(tl.ms(2500) / 1000)
        },
      ],
      [
        2500,
        () => {
          say('silence()')
          sfx.silence()
        },
      ],
    ]),
    PHONE,
  ),
  item('heartbeat', 'heartbeat 鼓動（96bpm・3 秒）', '低い 2 拍（ドクン・ドクン）。ms たったら自然に止まる', (tl) =>
    cue(tl, 3800, [[0, () => sfx.heartbeat(96 * tl.speed, tl.ms(3000))]]),
    PHONE,
  ),
  item('heartbeat-cut', 'heartbeat → silence', '鼓動の途中（1.6 秒）で silence() で止める', (tl, say) =>
    cue(tl, 2400, [
      [
        0,
        () => {
          say('heartbeat(110, 4000)')
          sfx.heartbeat(110 * tl.speed, tl.ms(4000))
        },
      ],
      [
        1600,
        () => {
          say('silence()')
          sfx.silence()
        },
      ],
    ]),
    PHONE,
  ),
  item('ma', 'ma 間（ま）', '鼓動 → 間（BGM を消し、低い空気だけを残す）→ 着地', (tl, say) =>
    cue(tl, 4400, [
      [
        0,
        () => {
          say('鼓動')
          sfx.heartbeat(100 * tl.speed, tl.ms(1500))
        },
      ],
      [
        1500,
        () => {
          say('間（ま）')
          sfx.ma()
        },
      ],
      [
        2900,
        () => {
          say('着地')
          sfx.silence()
          sfx.impact(2)
        },
      ],
    ]),
  ),
  item('gold-rise', 'goldRise 金の粒', '金の粒子が立ち上る（上っていく粒と、遠くからふくらむ和音）', once(sfx.goldRise, 2200), PHONE),
  item('push-ready', 'pushReady 合図待ち', '以前の「司会の合図待ち」に入る音（「ガシャン」と構え、「ギュイッ」と溜め、明るい 2 音で促す）。合図待ちは、なくした', once(sfx.pushReady, 3200), UNUSED),
  ...([0, 1, 2, 3, 4] as const).map((t) => item(`impact-${t}`, `impact ${t} 着地`, IMPACT_NOTE[t], once(() => sfx.impact(t), 2600), t >= 3 ? UNUSED : GROUP)),
  ...(['small', 'medium', 'big'] as const).map((size) =>
    item(`fanfare-${size}`, `fanfare ${size}`, FANFARE_NOTE[size], once(() => sfx.fanfare(size), size === 'big' ? 4400 : 2600)),
  ),
  item('kakutei', 'kakutei 確定音（虹だけ）', 'キュイン・キュイン → ちゅいーん → きらきら。BGM は 0.15 まで下がる', once(sfx.kakutei, 2800)),
  item('crack', 'crack 虹のヒビ', 'ピキ…ピキピキッ → 氷のきしみ → 最後に大きく割れる', once(sfx.crack, 2400)),
  item('rainbow-chord', 'rainbowChord 虹の和音', '虹のグリッサンド → 大きな和音（合唱の「アー」・鐘）→ 降り注ぐきらきら', once(sfx.rainbowChord, 4800)),
  item('final-ball', 'finalBall 最後の 1 球', 'ドン、ドン → ジャーン → 属七で解決させずに張りつめる', once(sfx.finalBall, 3000)),

  // ---- 流れ（本番に近い順番と間隔） -------------------------------------------
  // 大画面の抽選機は、どの回も「回る → ゆっくりになる → 着地」。変わるのは、結果で決まる着地の強さだけ
  ...([0, 1, 2] as const).map((power) =>
    item(
      `flow-stage-${power}`,
      `大画面の抽選: ${STAGE_LAND[power]}`,
      power === 2
        ? 'コマ送り → ゆっくりになる → 着地（少し強く）→ ファンファーレ（人数で大きさが変わる。ここでは small）'
        : 'コマ送り → ゆっくりになる → 着地',
      (tl, say) => {
        reel(tl, 300, 6500, 55)
        reel(tl, 6800, 600, 150)
        const events: Cue[] = [
          [
            0,
            () => {
              say('回り出す')
              sfx.tick()
            },
          ],
          [6800, () => say('ゆっくりになる')],
          [
            7400,
            () => {
              say(`着地（${STAGE_LAND[power]}）`)
              sfx.impact(power)
            },
          ],
        ]
        if (power === 2) {
          events.push([
            8000,
            () => {
              say('ビンゴ！')
              sfx.fanfare('small')
            },
          ])
        }
        return cue(tl, power === 2 ? 10400 : 9000, events)
      },
      FLOW,
    ),
  ),
  item(
    'flow-rainbow',
    '全員確定: 止める → 確定音 → ヒビ → 虹の和音',
    '大画面の虹。すべてを止めて、確定音で「確定」を知らせ、ヒビから虹の和音へ',
    (tl, say) => {
      reel(tl, 0, 900, 55)
      return cue(tl, 8800, [
        [
          900,
          () => {
            say('すべてを止める')
            sfx.silence()
            sfx.ma()
          },
        ],
        [
          1700,
          () => {
            say('確定音')
            sfx.kakutei()
          },
        ],
        [
          3400,
          () => {
            say('虹のヒビ')
            sfx.crack()
          },
        ],
        [
          4900,
          () => {
            say('全員確定！')
            sfx.rainbowChord()
          },
        ],
      ])
    },
    FLOW,
  ),
  item(
    'flow-final',
    '最後の 1 球 → 着地（ビンゴが出た）',
    '「この1球で景品が尽きる」の予告から、抽選の着地まで',
    (tl, say) => {
      reel(tl, 3000, 2000, 55)
      reel(tl, 5000, 800, 150)
      return cue(tl, 7600, [
        [
          0,
          () => {
            say('この 1 球で景品が尽きる！')
            sfx.finalBall()
          },
        ],
        [3000, () => say('抽選')],
        [
          5800,
          () => {
            say('着地')
            sfx.impact(2)
          },
        ],
        [
          6300,
          () => {
            say('ビンゴ！')
            sfx.fanfare('small')
          },
        ],
      ])
    },
    FLOW,
  ),
)
