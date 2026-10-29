import './styles.css'
import { Clock } from './demo/clock'
import { DemoAuthority, type Settings } from './demo/authority'
import { LocalHub } from './net/hub'
import { HostView } from './ui/host'
import { PhoneView } from './ui/phone'
import { sound } from './ui/sound'
import { StageView } from './ui/stage'
import { q } from './ui/dom'

// サーバーなしの一人用デモ。本番の 3 画面（主催・大画面・参加者）を 1 画面に並べ、
// 権威（本番ではサーバー）もブラウザの中で動かす。画面どうしは hub のメッセージだけでつながる

const app = q(document, '#app')
app.innerHTML = `
  <header class="topbar">
    <b class="brand">Bingoo</b><span class="tag">DEMO</span>
    <span class="muted">サーバーなしの一人用デモ。あなた以外の参加者は仮想です</span>
  </header>
  <main class="layout">
    <section class="pane pane-host"></section>
    <section class="pane pane-stage"><span class="pane-label">会場の大画面</span></section>
    <section class="pane pane-phone"><span class="pane-label">あなたのスマホ</span></section>
  </main>`

const params = new URLSearchParams(location.search)
const settings: Settings = {
  seed: params.get('seed') ?? Math.random().toString(36).slice(2, 8),
  size: Number(params.get('size') ?? 1000),
  prizeCount: Number(params.get('prizes') ?? 30),
}

const hub = new LocalHub()
const clock = new Clock()
clock.speed = Number(params.get('speed') ?? 1)
const authority = new DemoAuthority(hub, clock)

new StageView(q(app, '.pane-stage'), hub, clock, () => authority.game?.players ?? [])
new PhoneView(q(app, '.pane-phone'), hub, clock, (cmd) => {
  if (cmd.type === 'join') authority.join()
  else authority.openPack()
})
new HostView(q(app, '.pane-host'), hub, clock, authority, (s) => void authority.newGame(s))

// 音はブラウザの決まりで、最初の操作のあとでないと鳴らせない
document.addEventListener('pointerdown', () => sound.unlock())

void authority.newGame(settings).then(() => {
  // ?auto=1 で自動進行（見本の再生や画面の確認用）
  if (params.get('auto') === '1') {
    authority.auto = true
    void authority.next()
  }
})
