import { escapeHtml } from '../runtime'
import './ball.css'

// 番号の見せ方（スマホの中は全部これ）: 列の文字の玉 ＋ 数字（「O の玉 61」）。抽選機の玉と同じ見た目にそろえる。
// 大きさは文字の大きさ（font-size）で決まる。文の中に置けば文字に合わせて小さく、単独で置けば大きくなる。
// 玉の大きさは、数字に対する倍率を CSS 変数 --fxn-ball で変えられる（文の中は 1.15、大きく見せるところは 0.8 くらい）。
// 玉の色は中立（白地に濃紺）。色は期待度の段階だけに使う。
//
//   numHtml(61)        // <span class="fxn" data-n="61"><i class="fxn-l">O</i><b class="fxn-n">61</b></span>
//   numHtml('O61')     // ラベルの文字列でもよい（数字だけを読む）

const LETTERS = 'BINGO'

export const letterOf = (n: number): string => LETTERS[Math.min(4, Math.max(0, Math.floor((n - 1) / 15)))]

// 「O61」「61」などから番号を読む（読めなければ NaN）
export const numOf = (label: string | number): number => (typeof label === 'number' ? label : Number(/\d+/.exec(label)?.[0] ?? NaN))

export function numHtml(n: number | string, cls = ''): string {
  const v = numOf(n)
  const c = cls ? `fxn ${cls}` : 'fxn'
  // 番号として読めないもの（「--」など）は、数字の場所にそのまま出す
  if (!(Number.isInteger(v) && v >= 1 && v <= 75)) return `<span class="${c}"><b class="fxn-n">${escapeHtml(String(n))}</b></span>`
  const l = letterOf(v)
  return `<span class="${c}" data-n="${v}" aria-label="${l}${v}"><i class="fxn-l" aria-hidden="true">${l}</i><b class="fxn-n" aria-hidden="true">${v}</b></span>`
}
