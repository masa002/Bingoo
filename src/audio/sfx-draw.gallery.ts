import { registerGallery, type GalleryItem } from '../fx/gallery'
import type { Timeline } from '../fx/runtime'
import { TIER_NAME, type Tier } from '../fx/theme'
import { engine } from './engine'
import { drawSfx as sfx } from './sfx-draw'

// 抽選まわりの効果音のギャラリー（URL に ?gallery を付けると開く）。
// 1 つずつの音と、本番に近い順で並べた「流れ」を登録する。伸ばす音（ライザー・鼓動）は数秒で止める見本にする

type Say = (text: string) => void
type Cue = readonly [ms: number, fn: () => void]

const GROUP = '音: 抽選'
const FLOW = '音: 抽選（流れ）'

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
const IMPACT_NOTE = [
  '青: 軽い「ポン」（いちばんよく鳴る音）',
  '緑: ポォン＋キラッ',
  '赤: 低音のドロップ・雑音のクラック・鐘',
  '金: さらに重く、シンバルと鐘の和音、長いきらきら',
  '虹: 金に、虹のグリッサンドとパッドを重ねる',
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
    item(`hold-${t}`, `holdChange ${TIER_NAME[t]}`, '保留（期待度）の色が上がった', once(() => sfx.holdChange(t), 1800)),
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
  }),
  item('flutter', 'flutter 群予告', 'カードの群れが左から右へ横切る（シュッ・バサバサ）', once(sfx.flutter, 1500)),
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
  }),
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
  ),
  item('heartbeat', 'heartbeat 鼓動（96bpm・3 秒）', '低い 2 拍（ドクン・ドクン）。ms たったら自然に止まる', (tl) =>
    cue(tl, 3800, [[0, () => sfx.heartbeat(96 * tl.speed, tl.ms(3000))]]),
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
  ),
  item('ma', 'ma 間（ま）', '鼓動 → 間（BGM を消し、低い空気だけを残す）→ 着地（赤）', (tl, say) =>
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
  item('gold-rise', 'goldRise 金の粒', '金の粒子が立ち上る（上っていく粒と、遠くからふくらむ和音）', once(sfx.goldRise, 2200)),
  item('push-ready', 'pushReady PUSH 待ち', '「ガシャン」と構え、「ギュイッ」と溜め、明るい 2 音で促す', once(sfx.pushReady, 3200)),
  ...([0, 1, 2, 3, 4] as const).map((t) => item(`impact-${t}`, `impact ${TIER_NAME[t]}`, IMPACT_NOTE[t], once(() => sfx.impact(t), 2600))),
  ...(['small', 'medium', 'big'] as const).map((size) =>
    item(`fanfare-${size}`, `fanfare ${size}`, FANFARE_NOTE[size], once(() => sfx.fanfare(size), size === 'big' ? 4400 : 2600)),
  ),
  item('kakutei', 'kakutei 確定音（虹だけ）', 'キュイン・キュイン → ちゅいーん → きらきら。BGM は 0.15 まで下がる', once(sfx.kakutei, 2800)),
  item('crack', 'crack 虹のヒビ', 'ピキ…ピキピキッ → 氷のきしみ → 最後に大きく割れる', once(sfx.crack, 2400)),
  item('rainbow-chord', 'rainbowChord 虹の和音', '虹のグリッサンド → 大きな和音（合唱の「アー」・鐘）→ 降り注ぐきらきら', once(sfx.rainbowChord, 4800)),
  item('final-ball', 'finalBall 最後の 1 球', 'ドン、ドン → ジャーン → 属七で解決させずに張りつめる', once(sfx.finalBall, 3000)),

  // ---- 流れ（本番に近い順番と間隔） -------------------------------------------
  item(
    'flow-blue',
    '青: すぐに着地',
    'コマ送り → 減速 → ポン',
    (tl, say) => {
      reel(tl, 300, 1700, 55)
      reel(tl, 2000, 600, 150)
      return cue(tl, 3200, [
        [
          0,
          () => {
            say('回転')
            sfx.tick()
          },
        ],
        [2000, () => say('減速')],
        [
          2600,
          () => {
            say('着地')
            sfx.impact(0)
          },
        ],
      ])
    },
    FLOW,
  ),
  item(
    'flow-green',
    '緑: 保留変化 → ライザー → 着地',
    '緑の保留 → 上がり続ける音 → ピタッと止めて着地',
    (tl, say) => {
      reel(tl, 300, 2500, 55)
      reel(tl, 2800, 1200, 90)
      return cue(tl, 5400, [
        [0, sfx.tick],
        [
          380,
          () => {
            say('保留変化（緑）')
            sfx.holdChange(1)
          },
        ],
        [
          2800,
          () => {
            say('ライザー')
            sfx.riser(tl.ms(1200) / 1000)
          },
        ],
        [
          4000,
          () => {
            say('着地')
            sfx.silence()
            sfx.impact(1)
          },
        ],
      ])
    },
    FLOW,
  ),
  item(
    'flow-red',
    '赤: ステップ → カットイン → 鼓動 → 間 → 着地',
    '激アツの流れ。着地のあと、ビンゴが出たらファンファーレ（small）',
    (tl, say) => {
      reel(tl, 300, 2300, 55)
      reel(tl, 2600, 800, 120)
      reel(tl, 3400, 1400, 260)
      return cue(tl, 8400, [
        [0, sfx.tick],
        [
          400,
          () => {
            say('STEP 1')
            sfx.step(0, 0)
          },
        ],
        [
          1000,
          () => {
            say('STEP 2')
            sfx.step(1, 1)
          },
        ],
        [
          1600,
          () => {
            say('STEP 3')
            sfx.step(2, 2)
          },
        ],
        [
          2200,
          () => {
            say('カットイン（赤）')
            sfx.cutin(2)
          },
        ],
        [
          3400,
          () => {
            say('鼓動')
            sfx.heartbeat(96 * tl.speed, tl.ms(1400))
          },
        ],
        [
          4800,
          () => {
            say('間（ま）')
            sfx.ma()
          },
        ],
        [
          5600,
          () => {
            say('着地')
            sfx.silence()
            sfx.impact(2)
          },
        ],
        [
          6100,
          () => {
            say('ビンゴ！')
            sfx.fanfare('small')
          },
        ],
      ])
    },
    FLOW,
  ),
  item(
    'flow-gold',
    '金: 金の粒 → ライザー → 間 → PUSH → 着地',
    '金は MC の PUSH を待ってから公開する。着地のあと、ビンゴのファンファーレ（medium）',
    (tl, say) => {
      reel(tl, 300, 4100, 55)
      reel(tl, 4400, 1800, 90)
      return cue(tl, 11200, [
        [0, sfx.tick],
        [
          400,
          () => {
            say('テロップ')
            sfx.telop()
          },
        ],
        [
          700,
          () => {
            say('STEP 1')
            sfx.step(0, 0)
          },
        ],
        [
          1300,
          () => {
            say('STEP 2')
            sfx.step(1, 1)
          },
        ],
        [
          1900,
          () => {
            say('STEP 3')
            sfx.step(2, 2)
          },
        ],
        [
          2500,
          () => {
            say('STEP 4')
            sfx.step(3, 3)
          },
        ],
        [
          3000,
          () => {
            say('カットイン（金）')
            sfx.cutin(3)
          },
        ],
        [
          3700,
          () => {
            say('金の粒')
            sfx.goldRise()
          },
        ],
        [
          4400,
          () => {
            say('ライザー')
            sfx.riser(tl.ms(1800) / 1000)
          },
        ],
        [
          6200,
          () => {
            say('間（ま）')
            sfx.ma()
          },
        ],
        [
          6800,
          () => {
            say('PUSH 待ち')
            sfx.pushReady()
          },
        ],
        [
          8600,
          () => {
            say('PUSH → 着地')
            sfx.silence()
            sfx.impact(3)
          },
        ],
        [
          9100,
          () => {
            say('ビンゴ！')
            sfx.fanfare('medium')
          },
        ],
      ])
    },
    FLOW,
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
    'flow-upgrade',
    '金→虹（昇格）: 金の流れから確定へ',
    '金の粒とライザーで金と見せて、フリーズ → ヒビ → 確定音 → PUSH → 虹の着地 → ファンファーレ（big）',
    (tl, say) => {
      reel(tl, 0, 700, 55)
      reel(tl, 700, 1200, 90)
      return cue(tl, 12000, [
        [
          0,
          () => {
            say('金の粒')
            sfx.goldRise()
          },
        ],
        [
          700,
          () => {
            say('ライザー')
            sfx.riser(tl.ms(1200) / 1000)
          },
        ],
        [
          1900,
          () => {
            say('フリーズ')
            sfx.silence()
            sfx.ma()
          },
        ],
        [
          2500,
          () => {
            say('ヒビ')
            sfx.crack()
          },
        ],
        [
          3900,
          () => {
            say('確定！')
            sfx.kakutei()
          },
        ],
        [
          5600,
          () => {
            say('PUSH 待ち')
            sfx.pushReady()
          },
        ],
        [
          7200,
          () => {
            say('PUSH → 着地（虹）')
            sfx.silence()
            sfx.impact(4)
          },
        ],
        [
          7700,
          () => {
            say('ビンゴ！')
            sfx.fanfare('big')
          },
        ],
      ])
    },
    FLOW,
  ),
  item(
    'flow-final',
    '最後の 1 球 → 赤の着地',
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
