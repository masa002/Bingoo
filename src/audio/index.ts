import { bgm } from './bgm'
import { engine } from './engine'
import { drawSfx } from './sfx-draw'
import { eventSfx } from './sfx-events'
import type { DrawSfx, EventSfx } from './types'

export type Sfx = DrawSfx & EventSfx

// 演出のコードはこの sfx と bgm だけを呼ぶ。実装は this に頼らない関数で書く（ここで合成するため）
export const sfx: Sfx = { ...drawSfx, ...eventSfx }
export { bgm, engine }
export type { BgmScene, GaraponVoice } from './types'
