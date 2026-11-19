import { registerGallery, type GalleryItem } from '../gallery'
import { openLastOneBrief, playLastOneGarapon, type LastOneGaraponOptions } from './lastone'

// ラストワン争奪のガラポン（スマホ）のギャラリー。呼び出し側の予定（玉 6.5 秒・全体 11 秒、7 人で 2 個）を基本にする。
// 大画面のギャラリー（stage/lastone.gallery.ts）と同じ時刻で 3・2・1 と玉が出る

const G = 'スマホ: ラストワン争奪'
const BASE = { dropAt: 6500, durationMs: 11000, contestants: 7, prizes: 2 }

const item = (id: string, label: string, o: Partial<LastOneGaraponOptions> & Pick<LastOneGaraponOptions, 'color'>): GalleryItem => ({
  id: `lastone-phone-${id}`,
  group: G,
  label,
  screen: 'phone',
  play: (host, tl) => playLastOneGarapon(host, { ...BASE, ...o, speed: tl.speed }),
})

// 説明の画面を wait ms 出してから閉じて、ガラポンへ進む（本番では、司会の「スタート」で閉じる）
const flow = (id: string, label: string, wait: number, autoMs: number | null, o: Partial<LastOneGaraponOptions> & Pick<LastOneGaraponOptions, 'color'>): GalleryItem => ({
  id: `lastone-phone-${id}`,
  group: G,
  label,
  screen: 'phone',
  play: async (host, tl) => {
    const brief = openLastOneBrief(host, { speed: tl.speed, prizes: BASE.prizes, contestants: BASE.contestants, autoMs })
    await tl.wait(wait)
    brief.close()
    if (tl.cancelled) return
    await playLastOneGarapon(host, { ...BASE, ...o, speed: tl.speed })
  },
})

registerGallery(
  flow('brief', '説明（6 秒。合図を待つ）→ ガラポン（大当たり 金）', 6000, null, { color: 'gold', prize: 'ワイヤレスイヤホン' }),
  flow('brief-auto', '説明（自動で 8 秒後に開始）→ ガラポン（外れ）', 8000, 8000, { color: 'white' }),
  {
    id: 'lastone-phone-brief-only',
    group: G,
    label: '説明だけ（30 秒出して、ガラポンへ進まずに閉じる）',
    screen: 'phone',
    play: async (host, tl) => {
      const brief = openLastOneBrief(host, { speed: tl.speed, prizes: 1, contestants: 27, autoMs: null })
      await tl.wait(30000)
      brief.close()
    },
  },
  item('red', '当たり（赤 ◆）', { color: 'red', prize: 'グルメカタログ' }),
  item('gold', '大当たり（金 ★）', { color: 'gold', prize: 'ワイヤレスイヤホン' }),
  item('rainbow', '超大当たり（虹 ✦）', { color: 'rainbow', prize: '特賞 温泉旅館ペア宿泊券' }),
  item('white', '外れ（白 ○ → ダブルチャンスの玉 3 個）', { color: 'white' }),
  item('all', '当たり（金）発表の音もすべて鳴らす（sound: all）', { color: 'gold', prize: 'ロボット掃除機', sound: 'all' }),
  item('many', '外れ（120 人で 6 個。人数が多いとき）', { color: 'white', contestants: 120, prizes: 6 }),
  item('early', '時間の端: 玉 4 秒・全体 9 秒（当たり 赤）', { color: 'red', prize: 'お菓子詰め合わせ', dropAt: 4000, durationMs: 9000 }),
  item('tight', '時間の端: 玉 8 秒・全体 9 秒（結果を縮める・外れ）', { color: 'white', dropAt: 8000, durationMs: 9000 }),
  item('long', '時間の端: 玉 8 秒・全体 13 秒（当たり 虹）', { color: 'rainbow', prize: '特賞 最新ゲーム機', dropAt: 8000, durationMs: 13000 }),
)
