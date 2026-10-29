import { registerGallery, type GalleryItem } from '../fx/gallery'
import { el, type Timeline } from '../fx/runtime'
import { bgm, bgmStatus } from './bgm'
import type { BgmScene } from './types'

// BGM の見本。場面ごとに一巡（イントロ ＋ 16 小節 × 2 周）を流し、最後は自分でフェードアウトして終わる。
// 鳴っている途中で別の BGM の項目を押すと、止めずにクロスフェードで切り替わる

const SCENES: ReadonlyArray<readonly [BgmScene, string]> = [
  ['reception', '受付'],
  ['early', '序盤'],
  ['reach', 'リーチ期'],
  ['bingo', 'ビンゴ期'],
  ['final', 'オーラス'],
  ['cooldown', 'ダブルチャンスと締め'],
]
const NAME = new Map<BgmScene, string>(SCENES)
const GROUP = '音: BGM'

let owner = 0 // いま BGM を鳴らしている項目。BGM の別の項目に移ったら、前の項目は止めない

// 実時間で待つ（ギャラリーの速度を変えても、曲の長さは変えない）。取り消されたら false
async function hold(tl: Timeline, sec: number): Promise<boolean> {
  await tl.wait(sec * 1000 * tl.speed)
  return !tl.cancelled
}

async function session(host: HTMLElement, tl: Timeline, body: () => Promise<boolean>): Promise<void> {
  const me = ++owner
  const close = monitor(host)
  bgm.duck(false)
  try {
    if ((await body()) && owner === me) {
      bgm.stop(2000)
      await hold(tl, 2.1)
    }
  } finally {
    close()
    // BGM 以外の見本に移ったときは、ここで止める
    if (tl.cancelled && owner === me) {
      bgm.duck(false)
      bgm.stop(500)
    }
  }
}

function line(css: string, text = ''): HTMLDivElement {
  const node = el('div')
  node.style.cssText = css
  node.textContent = text
  return node
}

// 曲名・調・テンポと、いま何小節目か（前半 A ＝ 1〜8、後半 B ＝ 9〜16）を出す
function monitor(host: HTMLElement): () => void {
  const root = line(
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;' +
      "text-align:center;color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui",
  )
  const title = line('font-size:96px;font-weight:900')
  const info = line('font-size:36px;color:#c9d2f5')
  const feel = line('font-size:28px;color:#8a93b8;max-width:1500px')
  const grid = line('display:grid;grid-template-columns:repeat(16,72px);gap:10px;margin-top:20px')
  const cells = Array.from({ length: 16 }, () => {
    const c = line('height:72px;border-radius:14px;display:grid;place-items:center;font-size:24px;font-weight:900')
    grid.append(c)
    return c
  })
  const beats = line('font-size:48px;letter-spacing:.4em')
  const state = line('font-size:32px;color:#c9d2f5')
  root.append(line('font-size:30px;letter-spacing:.3em;color:#8a93b8', '♪ BGM'), title, info, feel, grid, beats, state)
  host.append(root)

  let raf = 0
  let last = ''
  const draw = (): void => {
    raf = requestAnimationFrame(draw)
    const s = bgmStatus()
    const key = s ? `${s.scene}|${s.bar}|${s.beat}|${s.lap}|${s.ducked}|${s.leaving}` : '-'
    if (key === last) return
    last = key
    if (!s) {
      title.textContent = '（止まっています）'
      info.textContent = feel.textContent = beats.textContent = state.textContent = ''
      cells.forEach((c) => (c.style.visibility = 'hidden'))
      return
    }
    title.textContent = s.title
    info.textContent = `${NAME.get(s.scene) ?? ''}（${s.scene}） ・ ${s.key} ・ ${s.bpm} BPM`
    feel.textContent = s.feel
    cells.forEach((c, i) => {
      const now = i + 1 === s.bar
      c.style.visibility = 'visible'
      c.textContent = now ? `▶${i + 1}` : String(i + 1)
      c.style.background = now ? '#f5c542' : i + 1 < s.bar ? '#2b3a7a' : '#141c40'
      c.style.color = now ? '#1a1400' : i < 8 ? '#8ea0d8' : '#b9a6ff'
    })
    beats.textContent = [1, 2, 3, 4].map((b) => (b === s.beat ? '●' : '○')).join('')
    const where = s.bar === 0 ? 'イントロ' : `${s.bar <= 8 ? '前半 A' : '後半 B'} ・ ${s.bar} / 16 小節`
    state.textContent = `${where} ・ ${s.lap} 周目${s.ducked ? ' ・ duck 中（0.25）' : ''}${s.leaving ? ' ・ フェードアウト中' : ''}`
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

registerGallery(
  ...SCENES.map(
    ([scene, name]): GalleryItem => ({
      id: `bgm-${scene}`,
      group: GROUP,
      label: `${name}（${scene}）`,
      screen: 'sound',
      play: (host, tl) =>
        session(host, tl, async () => {
          bgm.play(scene)
          const bpm = bgmStatus()?.bpm ?? 120
          return hold(tl, (33 * 4 * 60) / bpm) // イントロ 1 小節 ＋ 16 小節 × 2 周
        }),
    }),
  ),
  {
    id: 'bgm-tour',
    group: GROUP,
    label: '場面を順に切り替え（クロスフェード）',
    screen: 'sound',
    play: (host, tl) =>
      session(host, tl, async () => {
        for (const [scene] of SCENES) {
          bgm.play(scene)
          if (!(await hold(tl, 9))) return false
        }
        return true
      }),
  },
  {
    id: 'bgm-duck',
    group: GROUP,
    label: 'duck（山場で 0.25 まで下げて戻す）',
    screen: 'sound',
    play: (host, tl) =>
      session(host, tl, async () => {
        bgm.play('bingo')
        if (!(await hold(tl, 6))) return false
        bgm.duck(true)
        if (!(await hold(tl, 4))) return false
        bgm.duck(false)
        return hold(tl, 6)
      }),
  },
  {
    id: 'bgm-stop',
    group: GROUP,
    label: 'stop（1.5 秒でフェードアウト）',
    screen: 'sound',
    play: async (host, tl) => {
      owner++
      const close = monitor(host)
      bgm.duck(false)
      bgm.stop(1500)
      await hold(tl, 1.8)
      close()
    },
  },
)
