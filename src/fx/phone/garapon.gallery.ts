import { registerGallery } from '../gallery'
import type { Timeline } from '../runtime'
import { DoubleChanceStage, type DoubleChanceWinner } from '../stage/doublechance'
import { askEntry, playFinalResult, playGarapon, type GaraponBall, type GaraponStats } from './garapon'

// ダブルチャンス（ガラポン）のギャラリー。スマホと大画面の両方をここで登録する

const PHONE = 'スマホ: ダブルチャンス'
const STAGE = '大画面: ダブルチャンス'

function garapon(id: string, label: string, balls: GaraponBall[], stats: GaraponStats) {
  return {
    id,
    group: PHONE,
    label,
    screen: 'phone' as const,
    play: (host: HTMLElement, tl: Timeline) => playGarapon(host, { speed: tl.speed, balls, stats }),
  }
}

function final(id: string, label: string, stats: GaraponStats) {
  return {
    id,
    group: PHONE,
    label,
    screen: 'phone' as const,
    play: (host: HTMLElement, tl: Timeline) => playFinalResult(host, { speed: tl.speed, stats }),
  }
}

// 景品の名前は、権威が送る形のまま（頭に賞の名前が付くものもある。大画面の側で外して、賞の名前の札にする）
const SAMPLE: DoubleChanceWinner[] = [
  { name: '佐藤 美咲', color: 'red', prize: 'ダブルチャンス賞 お菓子セット', isMe: false },
  { name: '鈴木 大輔', color: 'red', prize: 'ダブルチャンス賞 ご当地グルメカタログギフト', isMe: false },
  { name: '高橋 結衣', color: 'gold', prize: 'ワイヤレスイヤホン', isMe: false },
  { name: 'あなた', color: 'red', prize: 'グルメカタログ', isMe: true },
  { name: '田中 翔太', color: 'red', prize: 'ドリップコーヒーセット', isMe: false },
  { name: '渡辺 健', color: 'gold', prize: 'スマートウォッチ', isMe: false },
  { name: '伊藤 さくら', color: 'rainbow', prize: '特賞 温泉旅館ペア宿泊券', isMe: false },
]

const MORE_NAMES = ['山本 七海', '中村 蓮', '小林 陽菜', '加藤 悠真', '吉田 葵', '山田 湊', '佐々木 結菜', '山口 颯', '松本 芽依', '井上 樹', '木村 凛', '林 大和', '斎藤 澪']
const MORE_PRIZES = ['エコバッグ', '入浴剤セット', 'オリジナルステッカー', 'ホットアイマスク', '高級タオルセット', 'Bluetooth スピーカー']

// 受付中に人数が増えていく様子（ms のあいだ、少しずつ増やす）
async function entrants(s: DoubleChanceStage, tl: Timeline, ms: number, to: number): Promise<void> {
  const steps = Math.max(1, Math.round(ms / 400))
  for (let i = 1; i <= steps && !tl.cancelled; i++) {
    s.setEntrants(Math.round(to * (1 - Math.pow(1 - i / steps, 2))))
    await tl.wait(ms / steps)
  }
}

registerGallery(
  {
    id: 'garapon-entry',
    group: PHONE,
    label: 'エントリー（30 秒。押すと完了）',
    screen: 'phone',
    play: async (host, tl) => {
      await askEntry(host, { speed: tl.speed, seconds: 30 })
    },
  },
  {
    id: 'garapon-entry-timeout',
    group: PHONE,
    label: 'エントリー（6 秒で時間切れ）',
    screen: 'phone',
    play: async (host, tl) => {
      await askEntry(host, { speed: tl.speed, seconds: 6 })
    },
  },
  garapon('garapon-white', 'ガラポン: はずれ（白）', [{ color: 'white' }], { hits: 9, maxReach: 2, nearMiss: 3 }),
  garapon('garapon-red', 'ガラポン: 当たり（赤）', [{ color: 'red', prize: 'グルメカタログ' }], { hits: 11, maxReach: 1, nearMiss: 1 }),
  garapon('garapon-gold', 'ガラポン: 大当たり（金）', [{ color: 'gold', prize: 'ワイヤレスイヤホン' }], { hits: 12, maxReach: 3, nearMiss: 2 }),
  garapon('garapon-rainbow', 'ガラポン: 超大当たり（虹）', [{ color: 'rainbow', prize: '特賞 温泉旅館ペア宿泊券' }], { hits: 8, maxReach: 1, nearMiss: 0 }),
  garapon(
    'garapon-multi',
    'ガラポン: 3 回（白・白・赤）',
    [{ color: 'white' }, { color: 'white' }, { color: 'red', prize: 'お菓子詰め合わせ' }],
    { hits: 14, maxReach: 3, nearMiss: 1 },
  ),
  garapon('garapon-won', 'ガラポン: 本編で景品あり＋はずれ', [{ color: 'white' }], { hits: 15, maxReach: 2, nearMiss: 0, won: 'スマートウォッチ' }),
  {
    id: 'garapon-outro',
    group: PHONE,
    label: 'ガラポン: 大画面の締めを待つ（outro。玉の結果のあと 6 秒待って、あなたの結果へ）',
    screen: 'phone',
    play: (host, tl) => {
      // 本番では、大画面の締め（おつかれさまでした）で解決する
      const outro = tl.wait(16000)
      return playGarapon(host, { speed: tl.speed, balls: [{ color: 'gold', prize: 'ロボット掃除機' }], stats: { hits: 10, maxReach: 2, nearMiss: 2 }, outro })
    },
  },
  final('garapon-final-prize', 'あなたの結果（エントリーなし）: 景品あり', { hits: 15, maxReach: 2, nearMiss: 0, won: 'スマートウォッチ', rank: 4 }),
  final('garapon-final-rank', 'あなたの結果（エントリーなし）: 景品なし・ビンゴ 第 12 位', { hits: 14, maxReach: 3, nearMiss: 1, rank: 12 }),
  final('garapon-final-none', 'あなたの結果（エントリーなし）: 景品なし（またの機会に！）', { hits: 9, maxReach: 2, nearMiss: 3 }),
  {
    id: 'garapon-flow',
    group: PHONE,
    label: '流れ: エントリー → ガラポン（金）',
    screen: 'phone',
    play: async (host, tl) => {
      const ok = await askEntry(host, { speed: tl.speed, seconds: 15 })
      if (!ok || tl.cancelled) return
      await tl.wait(2500) // 押したあとの「締め切りまで あと N 秒」を少し見せる
      if (tl.cancelled) return
      await playGarapon(host, { speed: tl.speed, balls: [{ color: 'gold', prize: 'ロボット掃除機' }], stats: { hits: 10, maxReach: 2, nearMiss: 2 } })
    },
  },
  {
    id: 'doublechance-flow',
    group: STAGE,
    label: '流れ: エントリー → 回す → 当選者（並んだあと 5 秒 読み上げる）→ おつかれさま',
    screen: 'stage',
    play: async (host, tl) => {
      const s = new DoubleChanceStage(host, { speed: tl.speed })
      s.entry(10)
      await entrants(s, tl, 10000, 812)
      await tl.wait(1500)
      if (tl.cancelled) return s.destroy()
      s.spin()
      await tl.wait(7000)
      if (tl.cancelled) return s.destroy()
      for (const w of SAMPLE) s.addWinner(w)
      // 本番では、当選者が並んだあと、司会の「次へ」を待ってから finish() を呼ぶ
      await tl.wait(900 + SAMPLE.length * 900 + 600 + 5000)
      if (tl.cancelled) return s.destroy()
      await s.finish()
      if (tl.cancelled) s.destroy()
    },
  },
  {
    id: 'doublechance-entry',
    group: STAGE,
    label: 'エントリー受付（30 秒）',
    screen: 'stage',
    play: async (host, tl) => {
      const s = new DoubleChanceStage(host, { speed: tl.speed })
      s.entry(30)
      await entrants(s, tl, 28000, 1000)
      if (tl.cancelled) s.destroy()
    },
  },
  {
    id: 'doublechance-many',
    group: STAGE,
    label: '当選者が多いとき（20 人。古い行から畳む。特賞は最後に大きく）',
    screen: 'stage',
    play: async (host, tl) => {
      const s = new DoubleChanceStage(host, { speed: tl.speed })
      s.setEntrants(3200)
      s.spin()
      await tl.wait(2500)
      if (tl.cancelled) return s.destroy()
      const list = [...SAMPLE]
      MORE_NAMES.forEach((name, i) =>
        list.push({ name, color: i % 6 === 2 ? 'gold' : 'red', prize: MORE_PRIZES[i % MORE_PRIZES.length], isMe: false }),
      )
      // 権威と同じく、良い景品ほど最後に出す
      const rank = { white: 0, red: 1, gold: 2, rainbow: 3 }
      list.sort((a, b) => rank[a.color] - rank[b.color])
      for (const w of list) s.addWinner(w)
      await tl.wait(900 + list.length * 900 + 600 + 4000)
      if (tl.cancelled) return s.destroy()
      await s.finish()
      if (tl.cancelled) s.destroy()
    },
  },
)
