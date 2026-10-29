import './gallery.css'
import { engine } from '../audio'
import { galleryItems, type GalleryItem } from '../fx/gallery'
import { Timeline, el } from '../fx/runtime'
import { fit } from '../ui/dom'

// 演出と音のギャラリー（URL に ?gallery を付けると開く）。各担当の *.gallery.ts を自動で読み込む
import.meta.glob('../**/*.gallery.ts', { eager: true })

export function mountGallery(app: HTMLElement): void {
  app.classList.add('gal-app')
  app.innerHTML = `
    <div class="gal">
      <aside class="gal-side">
        <h1>Bingoo 演出ギャラリー</h1>
        <div class="gal-speed">速度 <button data-s="0.5">×0.5</button><button data-s="1" class="on">×1</button><button data-s="2">×2</button></div>
        <div class="gal-list"></div>
      </aside>
      <main class="gal-main">
        <div class="gal-title">左の一覧から選んでください</div>
        <div class="gal-view gal-stage-wrap"><div class="gal-stage"></div></div>
        <div class="gal-view gal-phone-wrap"><div class="gal-phone"></div></div>
      </main>
    </div>`
  const stage = app.querySelector<HTMLElement>('.gal-stage')!
  const phone = app.querySelector<HTMLElement>('.gal-phone')!
  fit(stage, 1920, 1080)
  fit(phone, 390, 844)

  let speed = 1
  let current: Timeline | null = null
  app.querySelectorAll<HTMLButtonElement>('[data-s]').forEach((b) =>
    b.addEventListener('click', () => {
      speed = Number(b.dataset.s)
      app.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('on', x === b))
    }),
  )

  const groups = new Map<string, GalleryItem[]>()
  for (const item of galleryItems()) groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  const list = app.querySelector<HTMLElement>('.gal-list')!
  if (!groups.size) list.textContent = 'まだ登録された演出がありません'
  for (const [group, items] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'ja'))) {
    list.append(el('h2', '', group))
    for (const item of items) {
      const b = el('button', 'gal-item', item.label)
      b.addEventListener('click', () => void play(item))
      list.append(b)
    }
  }

  async function play(item: GalleryItem): Promise<void> {
    engine.unlock()
    current?.cancel()
    const tl = new Timeline(speed)
    current = tl
    app.querySelector('.gal-title')!.textContent = `${item.group} ／ ${item.label}`
    app.querySelector('.gal-main')!.setAttribute('data-screen', item.screen)
    const target = item.screen === 'phone' ? phone : stage
    stage.replaceChildren()
    phone.replaceChildren()
    const host = el('div', item.screen === 'phone' ? 'gal-host gal-host-phone' : 'gal-host gal-host-stage')
    target.append(host)
    try {
      await item.play(host, tl)
    } catch (err) {
      console.error(err)
      app.querySelector('.gal-title')!.textContent = `エラー: ${String(err)}`
    }
  }
}
