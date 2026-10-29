import { registerGallery } from '../gallery'
import { playAllKakutei, playFinalBall, playLastOne, playMole } from './events'

// 大画面の特別なイベントのギャラリー。後ろに大画面の配置（HUD・抽選機・結果・会場・番号の盤）を薄く描いて、
// 重ねたときの見え方も確かめられるようにする

const G = '大画面: イベント'

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

const ANIMALS = ['しろくま', 'ぱんだ', 'きつね', 'うさぎ', 'ねこ', 'たぬき', 'ぺんぎん', 'こあら', 'らっこ', 'かわうそ', 'はりねずみ', 'あるぱか', 'ふくろう', 'いるか']

// 仮の参加者（me 番目が自分、wins に入っている番目が当たり）
function entrants(n: number, me: number, wins: readonly number[]): { name: string; isMe: boolean; win: boolean }[] {
  return Array.from({ length: n }, (_, i) => ({
    name: ANIMALS[(i * 5) % ANIMALS.length] + String((i * 137 + 42) % 1000).padStart(3, '0'),
    isMe: i === me,
    win: wins.includes(i),
  }))
}

registerGallery(
  {
    id: 'stage-event-kakutei',
    group: G,
    label: '全員確定（虹）1,000 人',
    screen: 'stage',
    play: (host, tl) => playAllKakutei(backdrop(host), { speed: tl.speed, total: 1000, newReach: 214, newDouble: 37 }),
  },
  {
    id: 'stage-event-kakutei-small',
    group: G,
    label: '全員確定（虹）30 人',
    screen: 'stage',
    play: (host, tl) => playAllKakutei(backdrop(host), { speed: tl.speed, total: 30, newReach: 6, newDouble: 1 }),
  },
  {
    id: 'stage-event-mole',
    group: G,
    label: 'モグラ（BAD）リーチが消えた人あり',
    screen: 'stage',
    play: (host, tl) => playMole(backdrop(host), { speed: tl.speed, total: 1000, hit: 128, lostReach: 41 }),
  },
  {
    id: 'stage-event-mole-safe',
    group: G,
    label: 'モグラ（BAD）リーチは全員無事',
    screen: 'stage',
    play: (host, tl) => playMole(backdrop(host), { speed: tl.speed, total: 300, hit: 12, lostReach: 0 }),
  },
  {
    id: 'stage-event-final',
    group: G,
    label: 'この1球で景品が尽きる！（残り 3 個）',
    screen: 'stage',
    play: (host, tl) => playFinalBall(backdrop(host), { speed: tl.speed, prizesLeft: 3 }),
  },
  {
    id: 'stage-event-final-many',
    group: G,
    label: 'この1球で景品が尽きる！（残り 14 個）',
    screen: 'stage',
    play: (host, tl) => playFinalBall(backdrop(host), { speed: tl.speed, prizesLeft: 14 }),
  },
  {
    id: 'stage-event-lastone',
    group: G,
    label: 'ラストワン争奪（27 人で 1 個）',
    screen: 'stage',
    play: (host, tl) => playLastOne(backdrop(host), { speed: tl.speed, prizes: 1, entrants: entrants(27, 4, [19]) }),
  },
  {
    id: 'stage-event-lastone-me',
    group: G,
    label: 'ラストワン争奪（7 人で 2 個・自分が当たる）',
    screen: 'stage',
    play: (host, tl) => playLastOne(backdrop(host), { speed: tl.speed, prizes: 2, entrants: entrants(7, 2, [2, 5]) }),
  },
)
