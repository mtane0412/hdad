/**
 * 注目コメントで「いま何を映すか」を決める部分
 *
 * オーバーレイ（focus/overlay/）は2つの入口から状態を受け取る。
 * - 取り上げているもの（FocusTarget）: Worker から定期的に読む（api.ts）
 * - 匿名IRCで届く発言とモデレーターの操作: チャットボックスと同じ接続（../chat/connection.ts）
 *
 * その2つをどう合わせて1件に決めるかだけをここに置き、通信（api.ts）とDOM（view.ts）から切り離す。
 *
 * 注意: 同じ取り上げているものを読み直したときは、状態をそのまま返す（30秒ごとに読み直すため）。
 * 読み直しのたびに作り直すと、人に追従しているときは映していた発言が消え、発言1件を取り上げているときは
 * モデレーターに消された発言が復活してしまう。
 * 注意: 人に追従する指定へ切り替えた直後は何も映さず、その人の次の発言から映す。IRCは過去の発言を
 * 送ってこないので、切り替えた時点より前の発言は手元に無い（貯めておいて掘り返すこともしない。
 * 「今から怖い話をする」と言った直後に切り替える使い方なので、映したいのは次の発言である）。
 */
import type { ChatMessage, Fragment } from '../chat/message'

/** いま取り上げているもの。worker/focus-config.ts の FocusTarget と合わせる */
export type FocusTarget =
  | {
      /** 人に追従する。その人の発言が届くたびに、映すものが最新の1件へ差し替わる */
      readonly type: 'viewer'
      /** 追従する人のログイン名（小文字） */
      readonly login: string
    }
  | {
      /** 発言1件を取り上げる。次の発言では差し替わらない */
      readonly type: 'message'
      readonly messageId: string
      readonly login: string
      readonly displayName: string
      /** 発言の本文（文字のみ。記録には本文しか残らないため、エモートの絵は持たない） */
      readonly text: string
    }

/** いま映している1件 */
export interface FocusedMessage {
  /** Twitchが振ったメッセージのID。消されたときに映すのをやめる目印になる */
  readonly messageId: string
  /** 発言した人のログイン名（小文字）。BAN・タイムアウトで消すときの目印になる */
  readonly login: string
  readonly displayName: string
  /** 本文の断片。人に追従しているときはIRCから届いたまま（公式エモートの絵を含む） */
  readonly fragments: readonly Fragment[]
}

/** オーバーレイの状態 */
export interface FocusState {
  /** いま取り上げているもの。取り上げていなければ null */
  readonly target: FocusTarget | null
  /** いま映している1件。映していなければ null */
  readonly shown: FocusedMessage | null
}

/** 何も取り上げていない状態（起動直後） */
export const NO_FOCUS: FocusState = { target: null, shown: null }

/** モデレーターの操作で発言が消えたこと */
export type FocusRemoval =
  /** 1件が削除された（CLEARMSG） */
  | { readonly type: 'message'; readonly messageId: string }
  /** その人の発言がまとめて消された（BAN・タイムアウト。CLEARCHAT） */
  | { readonly type: 'user'; readonly login: string }
  /** チャットが全部消された（CLEARCHAT） */
  | { readonly type: 'all' }

/** 2つの指定が同じものを指すか。読み直しで作り直さないための判定に使う */
const sameTarget = (a: FocusTarget | null, b: FocusTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.type !== b.type) return false
  if (a.type === 'viewer' || b.type === 'viewer') return a.login === b.login
  return a.messageId === b.messageId && a.login === b.login && a.displayName === b.displayName && a.text === b.text
}

/** 取り上げる指定から、映す1件を作る。人に追従する指定では、次の発言を待つので何も映さない */
const shownOf = (target: FocusTarget | null): FocusedMessage | null =>
  target === null || target.type === 'viewer'
    ? null
    : {
        messageId: target.messageId,
        login: target.login,
        displayName: target.displayName,
        fragments: [{ type: 'text', text: target.text }],
      }

/**
 * 取り上げているものを読み直した結果を反映する。
 *
 * @param target 読み出した指定。取り上げていなければ null
 */
export const withTarget = (state: FocusState, target: FocusTarget | null): FocusState =>
  sameTarget(state.target, target) ? state : { target, shown: shownOf(target) }

/**
 * IRCで届いた発言を反映する。
 *
 * 人に追従しているときだけ、その人の発言で映すものを差し替える。ログイン名の照合は大文字小文字を
 * 区別しない（Twitchの照合と合わせる）。
 */
export const withMessage = (state: FocusState, message: ChatMessage): FocusState => {
  const { target } = state
  if (target === null || target.type !== 'viewer' || message.login.toLowerCase() !== target.login) return state
  return {
    target,
    shown: {
      messageId: message.id,
      login: message.login.toLowerCase(),
      displayName: message.displayName,
      fragments: message.fragments,
    },
  }
}

/** 映している1件が、この操作で消えたか */
const removed = (shown: FocusedMessage, removal: FocusRemoval): boolean => {
  switch (removal.type) {
    case 'message':
      return shown.messageId === removal.messageId
    case 'user':
      return shown.login === removal.login.toLowerCase()
    case 'all':
      return true
  }
}

/**
 * モデレーターの操作を反映する。
 *
 * 映している1件が消されたら映すのをやめる。取り上げているものは外さない（配信者が外すまで残す）が、
 * 読み直しでは映すのを再開しない（withTarget が同じ指定を状態ごと据え置くため）。
 */
export const withRemoval = (state: FocusState, removal: FocusRemoval): FocusState =>
  state.shown !== null && removed(state.shown, removal) ? { ...state, shown: null } : state
