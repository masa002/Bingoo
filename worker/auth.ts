import { NAME_MAX } from '../src/net/wire'

// 認証まわりと、外から届いた値の整え方。WebCrypto だけで書く（Workers にも Node にもある）

// wrangler.jsonc に書いていない値（秘密と、あとから足す R2）。なくても動くように、どれも「ないかもしれない」型にする
export type AppEnv = Env & { ADMIN_KEY?: string; DEV?: string; BACKUP?: R2Bucket }

const enc = new TextEncoder()

// ---- 乱数とコード -----------------------------------------------------------

// まぎらわしい文字（0 と O、1 と I と L）を除いた英数字。口で伝えたり、手で打ったりするため
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

function randomText(length: number): string {
  let text = ''
  while (text.length < length) {
    // 31 文字なので、248 以上の値は捨てる（余りのかたよりをなくす）
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 248 && text.length < length) text += ALPHABET[b % ALPHABET.length]
    }
  }
  return text
}

// ゲームのコード（6 文字）
export function newCode(): string {
  return randomText(6)
}

// URL に入ってきたコードを確かめる（小文字で打っても通す）。形が違えば null
export function cleanCode(raw: string): string | null {
  const code = raw.toUpperCase()
  return /^[A-HJKMNP-Z2-9]{6}$/.test(code) ? code : null
}

// 主催キー（16 文字。4 文字ずつ - で区切って見せる）
export function newHostKey(): string {
  return randomText(16).replace(/(.{4})(?=.)/g, '$1-')
}

// 主催キーは、区切りや大文字・小文字の違いを気にせずに比べる
export function cleanHostKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// ---- 名前 -------------------------------------------------------------------

// 制御文字と、文字の向きを変える記号・見えない空白を除く（大画面に出るので、表示を壊されないように）
const UNSAFE = /[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  const text = raw.slice(0, max * 16).normalize('NFC').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  // 絵文字などを途中で切らないように、見た目の 1 文字ごとに数える
  const chars = [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
  return chars.slice(0, max).join('').trim()
}

// 表示名を整える。空なら null
export function cleanName(raw: unknown): string | null {
  return cleanText(raw, NAME_MAX) || null
}

// ---- 届いた本文 -------------------------------------------------------------

// 本文を、多くても max バイトまで読む。長すぎれば null。
// content-length が書いてあれば、読む前に断る。書いていなくても（分けて送られてくる本文）、読みながら数えて、超えたところでやめる
export async function readText(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && !(Number(declared) <= max)) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.byteLength
  }
  return new TextDecoder().decode(bytes)
}

// ---- 文字列の変換 -----------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let text = ''
  for (const b of bytes) text += b.toString(16).padStart(2, '0')
  return text
}

function fromHex(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length >> 1)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) return null
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function toBase32(bytes: Uint8Array): string {
  let text = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      text += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits) text += B32[(acc << (5 - bits)) & 31]
  return text
}

function fromBase32(text: string): Uint8Array {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const c of text.toUpperCase()) {
    const v = B32.indexOf(c)
    if (v < 0) continue
    acc = ((acc << 5) | v) & 0xfff
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

// ---- くらべる・ハッシュ -----------------------------------------------------

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

// 2 つの文字列が同じか。かかる時間から中身を推し量られないように、ハッシュにしてから、時間の差が出ない比べ方をする
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  return crypto.subtle.timingSafeEqual(x, y)
}

// 主催キーは、そのままでは保存しない（ゲームの鍵と合わせたハッシュで持つ）
export async function hostKeyHash(gameKey: string, hostKey: string): Promise<string> {
  return toHex(await sha256(`${gameKey}:${cleanHostKey(hostKey)}`))
}

// ---- トークン（HMAC-SHA256） -----------------------------------------------
// 参加者: HMAC(鍵, "p:" + idx) の base64url。主催: exp + "." + HMAC(鍵, "h:" + exp)。
// サーバーに一覧を持たなくても、鍵があれば確かめられる（受け口が自分で確かめられるので、進行役に聞かなくて済む）

export const HOST_TOKEN_MS = 12 * 60 * 60 * 1000

export function tokenKey(gameKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromHex(gameKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

async function sign(key: CryptoKey, text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))))
}

async function verify(key: CryptoKey, text: string, signature: string): Promise<boolean> {
  const bytes = fromBase64Url(signature)
  return bytes !== null && (await crypto.subtle.verify('HMAC', key, bytes, enc.encode(text)))
}

export function playerToken(key: CryptoKey, idx: number): Promise<string> {
  return sign(key, `p:${idx}`)
}

export async function checkPlayerToken(key: CryptoKey, idx: number, token: unknown): Promise<boolean> {
  return typeof token === 'string' && Number.isInteger(idx) && idx >= 0 && (await verify(key, `p:${idx}`, token))
}

export async function hostToken(key: CryptoKey, expiresAt: number): Promise<string> {
  return `${expiresAt}.${await sign(key, `h:${expiresAt}`)}`
}

export async function checkHostToken(key: CryptoKey, token: unknown, now: number): Promise<boolean> {
  if (typeof token !== 'string') return false
  const dot = token.indexOf('.')
  const exp = token.slice(0, dot)
  if (dot < 1 || !/^\d{1,16}$/.test(exp) || Number(exp) <= now) return false
  return verify(key, `h:${exp}`, token.slice(dot + 1))
}

// ---- TOTP（RFC 6238。SHA-1・6 桁・30 秒。認証アプリのふつうの設定） ----------

const TOTP_STEP_MS = 30000

export function newTotpSecret(): string {
  return toBase32(crypto.getRandomValues(new Uint8Array(20)))
}

export function totpUri(secret: string, code: string): string {
  return `otpauth://totp/${encodeURIComponent(`Bingoo:${code}`)}?secret=${secret}&issuer=Bingoo&algorithm=SHA1&digits=6&period=30`
}

async function totpAt(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const msg = new DataView(new ArrayBuffer(8))
  msg.setUint32(0, Math.floor(counter / 0x100000000))
  msg.setUint32(4, counter >>> 0)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg.buffer))
  const at = mac[19] & 15
  const value = ((mac[at] & 0x7f) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3]
  return String(value % 1000000).padStart(6, '0')
}

// 6 桁の数字を確かめる。端末の時計のずれを見込んで、前後 1 つの時間枠まで許す。
// 当たった時間枠の番号を返す（いくつも当たったら、いちばん新しい枠）。当たらなければ null。
// 呼ぶ側は、前に通した枠と同じか古い枠の 6 桁を断る（同じ 6 桁で 2 回入れないように）
export async function totpWindow(secret: string, code: unknown, now: number): Promise<number | null> {
  if (typeof code !== 'string') return null
  const digits = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(digits)) return null
  const counter = Math.floor(now / TOTP_STEP_MS)
  let hit: number | null = null
  for (const d of [-1, 0, 1]) {
    // 当たっても途中でやめない（どの枠で当たったかを、かかる時間から知られないように）
    if (await safeEqual(await totpAt(secret, counter + d), digits)) hit = counter + d
  }
  return hit
}
