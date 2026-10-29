import type { Timeline } from './runtime'

// 演出と音を 1 つずつ再生して確かめるための一覧（URL に ?gallery を付けると開く）。
// 各担当は自分のフォルダに *.gallery.ts を置き、registerGallery で登録する。読み込みは自動

export type GalleryScreen = 'stage' | 'phone' | 'sound'

export interface GalleryItem {
  id: string
  group: string // 例: '大画面: 抽選'、'スマホ: あおり'、'音: 抽選'
  label: string
  screen: GalleryScreen
  // host は screen に応じて 1920×1080 の大画面か 390×844 のスマホ画面（音だけなら空の要素）
  play(host: HTMLElement, tl: Timeline): Promise<void> | void
}

const items: GalleryItem[] = []

export function registerGallery(...list: GalleryItem[]): void {
  for (const item of list) if (!items.some((x) => x.id === item.id)) items.push(item)
}

export function galleryItems(): readonly GalleryItem[] {
  return items
}
