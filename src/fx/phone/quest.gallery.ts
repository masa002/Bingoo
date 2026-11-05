import { registerGallery, type GalleryItem } from '../gallery'
import type { Timeline } from '../runtime'
import { CardView, boxIn } from './card'
import { MoleQuest, type MoleQuestResult } from './quest'

// 緊急クエスト「モグラ撃退」のスマホ側のギャラリー。見本の画面は ui/phone.ts と同じ並び（ステータス・名前・リーチの札・カード・最新の番号・履歴）。
// 叩く時間は、自動の叩き手がそれらしく叩く（やられる回は下手に、守りきる回は上手に）。
// 見ている人が画面をタップしたら、自動の叩き手は止まり、そこからは自分で遊べる。
// 大画面がないので、音は警報・合図も含めてすべて鳴らす（sound: 'all'）。
// 結果のあとは、組み込み側の呼び方の見本として、埋められたマスとリーチの札を描き直す

const G = 'スマホ: 緊急クエスト（自動で叩く。タップで交代）'
const CARD5 = [3, 22, 38, 51, 67, 12, 17, 44, 59, 70, 7, 28, 0, 48, 62, 15, 19, 33, 56, 74, 1, 25, 41, 53, 65]
const HISTORY = [20, 3, 17, 56, 22, 74] // 見本の履歴（新しい順）
const bits = (...cells: number[]): number => cells.reduce((m, i) => m | (1 << i), 0)
const DIAG4 = bits(0, 6, 12, 18) // 斜めがあと 1 つ（O65）
const label = (n: number): string => `${'BINGO'[Math.floor((n - 1) / 15)]}${n}`

// 自動の叩き手の腕前。notice = 気づく割合、react = 気づいてから押すまで（ms）、gap = 次を押せるまで（ms）、acc = 当たる割合
interface Skill {
  notice: number
  react: number
  gap: number
  acc: number
}

const CASUAL: Skill = { notice: 0.5, react: 650, gap: 450, acc: 0.78 } // なんとなく（10 秒で 8 匹前後）
const KEEN: Skill = { notice: 0.97, react: 380, gap: 230, acc: 0.93 } // 熱心（25 匹前後）
const MID: Skill = { notice: 0.8, react: 500, gap: 320, acc: 0.88 } // ふつう（17 匹前後）

interface Spec {
  id: string
  label: string
  mask: number // クエスト前のカード
  waiting: number[] // あと 1 つのマス
  cell: number | null // ボスが狙うマス（狙われていなければ null）
  lost: boolean
  need: number
  skill: Skill
}

const SPECS: Spec[] = [
  {
    id: 'lost',
    label: '狙われて、やられる（あと 4 匹で守れた）',
    mask: DIAG4,
    waiting: [24],
    cell: 6,
    lost: true,
    need: 4,
    skill: CASUAL,
  },
  {
    id: 'defend',
    label: '狙われて、守りきる（防衛成功）',
    mask: DIAG4 | bits(10, 11),
    waiting: [24],
    cell: 18,
    lost: false,
    need: 0,
    skill: KEEN,
  },
  {
    id: 'free',
    label: '狙われていない（撃退数と順位）',
    mask: bits(1, 12, 19),
    waiting: [],
    cell: null,
    lost: false,
    need: 0,
    skill: MID,
  },
]

interface Mock {
  card: CardView
  chip: HTMLElement
}

// ---- 見本の画面 ----------------------------------------------------------------

function mockPhone(host: HTMLElement, tl: Timeline, mask: number, waiting: readonly number[]): Mock {
  host.insertAdjacentHTML(
    'beforeend',
    `<div style="position:absolute;inset:0;background:radial-gradient(120% 60% at 50% 0%,#16204a,#0a0f24 60%,#070b1a);color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif;font-size:15px">
      <div style="display:flex;justify-content:space-between;padding:12px 26px 4px;font-size:13px;font-weight:700"><span>9:41</span><span>●●● 100%</span></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 16px 4px"><div><b style="font-size:18px">あなた</b><small style="margin-left:8px;color:#8a93b8">No.00042</small></div><div style="color:#8a93b8;font-size:13px">参加 1,000人</div></div>
      <div style="min-height:38px;margin:0 14px"><div data-k="chip"></div></div>
      <div data-k="card" style="position:relative;margin-top:6px"></div>
      <div style="position:relative;margin-top:8px;text-align:center"><small style="display:block;color:#8a93b8">最新の番号</small><b style="font-size:40px;font-weight:900">${label(HISTORY[0])}</b></div>
      <div data-k="history" style="display:flex;flex-wrap:wrap;gap:5px;justify-content:center;padding:0 14px;margin-top:6px">${HISTORY.map(
        (n) =>
          `<span style="font-size:12px;padding:2px 7px;border-radius:999px;background:${CARD5.includes(n) ? 'rgba(255,92,122,0.35)' : '#18204a'};color:${CARD5.includes(n) ? '#fff' : '#8a93b8'}">${label(n)}</span>`,
      ).join('')}</div>
    </div>`,
  )
  const root = host.lastElementChild as HTMLElement
  const $ = (k: string): HTMLElement => root.querySelector<HTMLElement>(`[data-k="${k}"]`)!
  const card = new CardView($('card'), { size: 5, speed: tl.speed })
  card.setCells(CARD5)
  card.setMarks(mask, { waiting })
  const m: Mock = { card, chip: $('chip') }
  setChip(m, waiting.length ? `リーチ　あと ${waiting.map((c) => label(CARD5[c])).join('・')}` : '')
  return m
}

function setChip(m: Mock, text: string): void {
  m.chip.textContent = text
  m.chip.style.cssText = text ? 'border-radius:10px;padding:6px 10px;font-weight:900;font-size:15px;color:#fff;background:linear-gradient(90deg,#ff7a3d,#ef4444)' : ''
}

// ギャラリーで別の演出に切り替えたら（host が外れたら）止める
function watch(host: HTMLElement, tl: Timeline, ...parts: { destroy(): void }[]): void {
  const check = () => {
    if (!host.isConnected || tl.cancelled) parts.forEach((p) => p.destroy())
    else requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

async function hold(tl: Timeline, ms: number): Promise<boolean> {
  await tl.wait(ms)
  return !tl.cancelled
}

const gauss = (m: number, s: number): number => m + s * Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random())

// 会場での順位（仮想の参加者の撃退数を、真ん中 14 匹・ばらつき ±6 匹くらいと見なす）
function rankOf(score: number, players: number): number {
  return Math.max(1, Math.min(players, 1 + Math.round((players - 1) / (1 + Math.exp((score - 14) / 3.5)))))
}

// ---- 自動の叩き手 ----------------------------------------------------------------

// 画面の (x, y)（390×844 の座標）を指で押したことにする
function tapAt(q: MoleQuest, x: number, y: number): void {
  const root = q.el
  const r = root.getBoundingClientRect()
  const k = r.width / (root.offsetWidth || 390) || 1
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: r.left + x * k,
    clientY: r.top + y * k,
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
  }
  root.dispatchEvent(new PointerEvent('pointerdown', init))
  root.dispatchEvent(new PointerEvent('pointerup', init))
}

// 顔を出したモグラに気づいたら、少し遅れて叩く（手は 1 つずつ順番に）。見ている人が自分で押したら止める
async function autoWhack(q: MoleQuest, tl: Timeline, skill: Skill): Promise<void> {
  let manual = false
  const onUser = (e: PointerEvent) => {
    if (e.isTrusted) manual = true
  }
  q.el.addEventListener('pointerdown', onUser)
  const seen = new Set<string>()
  let free = 0 // 手が次に空く時刻（演出上の ms）
  let t = 0
  try {
    // 叩く時間になるまで待つ
    while (!tl.cancelled && q.el.isConnected && q.el.dataset.phase === 'intro') {
      await tl.wait(40)
      t += 40
    }
    while (!tl.cancelled && !manual && q.el.isConnected && q.el.dataset.phase === 'play') {
      for (const node of q.el.querySelectorAll<HTMLElement>('.fxq-hole.is-up')) {
        const key = `${node.dataset.i}:${node.dataset.n}`
        if (seen.has(key)) continue
        seen.add(key)
        if (Math.random() > skill.notice) continue
        const at = Math.max(t + Math.max(150, gauss(skill.react, skill.react * 0.2)), free)
        free = at + Math.max(100, gauss(skill.gap, skill.gap * 0.2))
        const hit = Math.random() < skill.acc
        tl.at(at - t, () => {
          if (manual || !node.isConnected) return
          const b = boxIn(node, q.el)
          // 外すときは、マスの外側（となりのマスとの境目のあたり）を押してしまう
          const dx = hit ? (Math.random() - 0.5) * b.w * 0.4 : (Math.random() < 0.5 ? -1 : 1) * b.w * 0.62
          tapAt(q, b.x + b.w / 2 + dx, b.y + b.h * 0.45 + (Math.random() - 0.5) * b.h * 0.3)
        })
      }
      await tl.wait(40)
      t += 40
    }
  } finally {
    q.el.removeEventListener('pointerdown', onUser)
  }
}

// ---- 一覧 ----------------------------------------------------------------------

function item(spec: Spec): GalleryItem {
  return {
    id: `phone-quest-${spec.id}`,
    group: G,
    label: spec.label,
    screen: 'phone',
    async play(host, tl) {
      const m = mockPhone(host, tl, spec.mask, spec.waiting)
      const q = new MoleQuest(host, { speed: tl.speed, sound: 'all' })
      watch(host, tl, q, m.card)
      if (!(await hold(tl, 500))) return
      const cell = spec.cell
      const playing = q.play(m.card, {
        introMs: 2600,
        playMs: 10000,
        target: cell !== null,
        cell,
        label: cell === null ? '' : label(CARD5[cell]),
      })
      void autoWhack(q, tl, spec.skill) // play を呼んだあと（警報が始まってから）見張り始める
      const score = await playing
      // 権威が結果を決めるまで（約 0.8 秒）
      if (!(await hold(tl, 800))) return
      const players = 1000
      const r: MoleQuestResult = {
        score,
        lost: spec.lost,
        need: spec.lost ? spec.need : 0,
        total: 17000 + Math.floor(Math.random() * 3000),
        rank: rankOf(score, players),
        players,
      }
      await q.result(r)
      if (tl.cancelled || !spec.lost || cell === null) return
      // 組み込み側の見本: 埋められたマスを状態に入れて描き直す（このカードでは斜めのリーチが消える）
      m.card.setMarks(spec.mask & ~(1 << cell), { filled: [cell] })
      setChip(m, '')
    },
  }
}

registerGallery(...SPECS.map(item))
