/**
 * 注目コメントで「いま何を映すか」を決める部分
 *
 * 合成ページの「注目コメント」の素材は、2つの入口から状態を受け取る。
 * - 取り上げている発言1件（FocusTarget）: Worker から定期的に読む（api.ts）
 * - モデレーターの操作: チャットボックスと同じ匿名IRCの接続（../chat/connection.ts）
 *
 * その2つをどう合わせて1件に決めるかだけをここに置き、通信（api.ts）とDOM（view.ts）から切り離す。
 *
 * 注意: 同じ1件を読み直したときは、状態をそのまま返す（10秒ごとに読み直すため）。読み直しのたびに
 * 作り直すと、モデレーターに消された発言が次の読み直しで復活してしまう。
 */

/** いま取り上げている発言1件。worker/focus-config.ts の FocusTarget と合わせる */
export interface FocusTarget {
  /** Twitchが振ったメッセージのID。消されたときに映すのをやめる目印になる */
  readonly messageId: string
  /** 発言した人のログイン名（小文字）。BAN・タイムアウトで消すときの目印になる */
  readonly login: string
  readonly displayName: string
  /** 発言の本文（文字のみ。記録には本文しか残らないため、エモートの絵は持たない） */
  readonly text: string
  /** 発言した人のアイコン画像のURL（取り上げた時点で Worker が Twitch から引いたもの） */
  readonly profileImageUrl: string
}

/** オーバーレイの状態 */
export interface FocusState {
  /** いま取り上げている1件。取り上げていなければ null */
  readonly target: FocusTarget | null
  /** いま映している1件。取り上げていない・モデレーターに消されたときは null */
  readonly shown: FocusTarget | null
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

/** 2つの1件が同じものか。読み直しで作り直さないための判定に使う */
const sameTarget = (a: FocusTarget | null, b: FocusTarget | null): boolean => {
  if (a === null || b === null) return a === b
  return (
    a.messageId === b.messageId &&
    a.login === b.login &&
    a.displayName === b.displayName &&
    a.text === b.text &&
    a.profileImageUrl === b.profileImageUrl
  )
}

/**
 * 取り上げているものを読み直した結果を反映する。
 *
 * @param target 読み出した1件。取り上げていなければ null
 */
export const withTarget = (state: FocusState, target: FocusTarget | null): FocusState =>
  sameTarget(state.target, target) ? state : { target, shown: target }

/** 映している1件が、この操作で消えたか */
const removed = (shown: FocusTarget, removal: FocusRemoval): boolean => {
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
 * 読み直しでは映すのを再開しない（withTarget が同じ1件を状態ごと据え置くため）。
 */
export const withRemoval = (state: FocusState, removal: FocusRemoval): FocusState =>
  state.shown !== null && removed(state.shown, removal) ? { ...state, shown: null } : state
