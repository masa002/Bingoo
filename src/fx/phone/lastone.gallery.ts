import { registerGallery, type GalleryItem } from '../gallery'
import { playLastOneGarapon, type LastOneGaraponOptions } from './lastone'

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

registerGallery(
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
