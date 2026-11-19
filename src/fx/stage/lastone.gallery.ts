import { registerGallery, type GalleryItem } from '../gallery'
import { openLastOneBrief, playLastOneGarapon, type LastOneStageOptions } from './lastone'

// ラストワン争奪のガラポン（大画面）のギャラリー。後ろに大画面の配置を薄く描いて、重ねたときの見え方も確かめる。
// 呼び出し側の予定（玉 6.5 秒・全体 11 秒）を基本にする（スマホのギャラリーと同じ時刻で 3・2・1 と発表が来る）

const G = '大画面: ラストワン争奪'

function backdrop(host: HTMLElement): HTMLElement {
  const boxes: readonly (readonly [string, number, number, number, number])[] = [
    ['HUD', 0, 0, 1920, 90],
    ['抽選機', 40, 90, 1200, 700],
    ['結果パネル', 1270, 110, 610, 390],
    ['会場ビュー', 1270, 520, 610, 260],
    ['番号の盤', 40, 800, 1840, 260],
  ]
  for (const [label, x, y, w, h] of boxes) {
    const box = document.createElement('div')
    box.textContent = label
    box.style.cssText =
      `position:absolute; left:${x}px; top:${y}px; width:${w}px; height:${h}px; box-sizing:border-box; padding:12px 18px;` +
      'border:2px solid rgba(138,147,184,.28); border-radius:18px; background:rgba(22,32,74,.35);' +
      'color:rgba(200,210,255,.45); font:800 28px system-ui, sans-serif'
    host.append(box)
  }
  return host
}

const FAMILY = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村']
const GIVEN = ['美咲', '大輔', '結衣', '翔太', 'さくら', '健', '七海', '蓮', '陽菜', '悠真', '葵', '湊', '結菜', '颯', '芽依', '樹', '凛']

// 仮の参加者（me 番目が自分、wins に入っている番目が当たり）
function entrants(n: number, me: number, wins: readonly number[]): LastOneStageOptions['entrants'] {
  return Array.from({ length: n }, (_, i) => ({
    name: `${FAMILY[(i * 7) % FAMILY.length]} ${GIVEN[(i * 5 + 3) % GIVEN.length]}`,
    isMe: i === me,
    win: wins.includes(i),
  }))
}

const item = (id: string, label: string, prizes: number, list: LastOneStageOptions['entrants'], time = { dropAt: 6500, durationMs: 11000 }): GalleryItem => ({
  id: `lastone-stage-${id}`,
  group: G,
  label,
  screen: 'stage',
  play: (host, tl) => playLastOneGarapon(backdrop(host), { speed: tl.speed, prizes, entrants: list, ...time }),
})

// 説明の画面を wait ms 出してから閉じて、ガラポンへ進む（本番では、司会の「スタート」で閉じる）
const flow = (id: string, label: string, wait: number, autoMs: number | null, prizes: number, list: LastOneStageOptions['entrants']): GalleryItem => ({
  id: `lastone-stage-${id}`,
  group: G,
  label,
  screen: 'stage',
  play: async (host, tl) => {
    const brief = openLastOneBrief(backdrop(host), { speed: tl.speed, prizes, entrants: list, autoMs })
    await tl.wait(wait)
    brief.close()
    if (tl.cancelled) return
    await playLastOneGarapon(host, { speed: tl.speed, prizes, entrants: list, dropAt: 6500, durationMs: 11000 })
  },
})

registerGallery(
  flow('brief', '説明（6 秒。司会の合図を待つ）→ ガラポン（7 人で 2 個・自分が当たり）', 6000, null, 2, entrants(7, 2, [2, 5])),
  flow('brief-auto', '説明（自動で 8 秒後に開始）→ ガラポン（3 人で 1 個）', 8000, 8000, 1, entrants(3, -1, [1])),
  flow('brief-many', '説明（多人数 27 人で 3 個。9 人と「ほか○人」）→ ガラポン', 6000, null, 3, entrants(27, 20, [4, 13, 22])),
  item('few', '少人数（3 人で 1 個）', 1, entrants(3, -1, [1])),
  item('me-win', '自分が当たり（7 人で 2 個）', 2, entrants(7, 2, [2, 5])),
  item('me-lose', '自分が外れ（7 人で 2 個）', 2, entrants(7, 3, [0, 5])),
  item('many', '多人数（27 人で 3 個。15 人と「ほか○人」）', 3, entrants(27, 20, [4, 13, 22])),
  item('crowd', '大人数（120 人で 6 個。自分は外れ）', 6, entrants(120, 57, [8, 31, 44, 70, 96, 118])),
  item('early', '時間の端: 発表 4 秒・全体 9 秒（5 人で 2 個）', 2, entrants(5, 0, [0, 3]), { dropAt: 4000, durationMs: 9000 }),
  item('tight', '時間の端: 発表 8 秒・全体 9 秒（12 人で 1 個）', 1, entrants(12, 6, [9]), { dropAt: 8000, durationMs: 9000 }),
)
