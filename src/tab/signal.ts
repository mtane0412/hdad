/**
 * タブの映像をつなぐための連絡（シグナリング）の形
 *
 * 送り手（拡張の offscreen document）と合成ページ（素材 `tab`）は、中継先（worker/tab-channel.ts の Durable Object）を通して
 * WebRTC の申し込み（offer）と回答（answer）をやりとりする。中継先は中身を読まないので、形を決めて読むのはここだけにする。
 *
 * 流れ:
 * 1. 合成ページはつながるたびに名乗る（hello）。送り手は映しているあいだ、名乗った合成ページごとに offer を送る
 * 2. 合成ページは自分あての offer にだけ answer を返す（合成ページが複数あっても、接続は合成ページごとに分かれる）
 * 3. 送り手は、映し始めたときと接続が切れたときに名乗り直しを頼む（who）。映すのをやめたら stop を送る
 *
 * ICE の候補は集め終えてから SDP にまとめて送るので、候補を1つずつ送る連絡は持たない（同じPCの中でつなぐため、すぐに集まる）。
 */
import { isRecord } from '../core/api'

/** 合成ページから送り手へ送る連絡 */
export type FromViewer = { type: 'hello'; viewerId: string } | { type: 'answer'; viewerId: string; sdp: string }

/** 送り手から合成ページへ送る連絡 */
export type FromSender = { type: 'who' } | { type: 'offer'; viewerId: string; sdp: string } | { type: 'stop' }

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** JSON を読む。読めなければ、誰からの連絡かを添えてエラーにする */
const readJson = (payload: string, from: string): unknown => {
  try {
    return JSON.parse(payload)
  } catch {
    throw new Error(`${from}からの連絡を読み取れませんでした（JSONとして読めません）`)
  }
}

/** 送り手が、合成ページから届いた文字列を読む。想定した形でなければエラーにする */
export const parseFromViewer = (payload: string): FromViewer => {
  const value = readJson(payload, '合成ページ')
  if (!isRecord(value)) throw new Error('合成ページからの連絡の形が想定と違います')
  if (value.type === 'hello') {
    if (!isText(value.viewerId)) throw new Error('合成ページからの連絡の形が想定と違います')
    return { type: 'hello', viewerId: value.viewerId }
  }
  if (value.type === 'answer') {
    if (!isText(value.viewerId) || !isText(value.sdp)) throw new Error('合成ページからの連絡の形が想定と違います')
    return { type: 'answer', viewerId: value.viewerId, sdp: value.sdp }
  }
  throw new Error('合成ページからの連絡の種類が想定と違います')
}

/** 合成ページが、送り手から届いた文字列を読む。想定した形でなければエラーにする */
export const parseFromSender = (payload: string): FromSender => {
  const value = readJson(payload, '送り手')
  if (!isRecord(value)) throw new Error('送り手からの連絡の形が想定と違います')
  if (value.type === 'who') return { type: 'who' }
  if (value.type === 'stop') return { type: 'stop' }
  if (value.type === 'offer') {
    if (!isText(value.viewerId) || !isText(value.sdp)) throw new Error('送り手からの連絡の形が想定と違います')
    return { type: 'offer', viewerId: value.viewerId, sdp: value.sdp }
  }
  throw new Error('送り手からの連絡の種類が想定と違います')
}
