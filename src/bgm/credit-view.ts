/**
 * 再生中の曲の表示（合成ページの素材「再生中の曲」）
 *
 * 裏方のページで流しているBGMの曲名とクレジット表記を、配信画面の隅に出しっぱなしにする（issue #152）。
 * DOMを扱うのはここだけにして、曲の受け取り（src/overlay/stage.ts の mountBgm）から切り離す。
 * クレジット先のURLは配信画面では押せないので出さない（視聴者へはチャットの差し込み語 {bgm} で伝える）。
 *
 * 注意: 同じ曲を受け取り直したときは、要素を作り直さない。つなぎ直すたびに読み直すので、
 * 毎回作り直すと曲が変わっていなくても出現のアニメーション（bgm.css）が走ってしまう。
 * 注意: 曲を止めているあいだは何も映さない。止めているのは正常な状態なので、エラーにしない。
 */

/** 表示に使う、流している曲の項目 */
export interface BgmCreditTrack {
  /** 音声の素材のID。曲の識別子 */
  readonly mediaId: string
  /** 曲名 */
  readonly title: string
  /** クレジット表記 */
  readonly credit: string
}

export interface BgmCreditView {
  /** 映す曲を書き換える。止めているときは null */
  setTrack(track: BgmCreditTrack | null): void
}

/** 映しているものと同じか。曲名やクレジット表記を直しただけでも出し直すので、3つとも比べる */
const sameTrack = (a: BgmCreditTrack | null, b: BgmCreditTrack | null): boolean =>
  a === b || (a !== null && b !== null && a.mediaId === b.mediaId && a.title === b.title && a.credit === b.credit)

/**
 * 再生中の曲の表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-bgm-credit] の要素）
 */
export const createBgmCreditView = (root: HTMLElement): BgmCreditView => {
  /** いま映している曲。受け取り直したときに作り直すかどうかの判定に使う */
  let 映している曲: BgmCreditTrack | null = null

  return {
    setTrack(track) {
      if (sameTrack(映している曲, track)) return
      映している曲 = track

      if (track === null) {
        root.replaceChildren()
        return
      }

      const 曲名 = document.createElement('p')
      曲名.className = 'bgm-credit-title'
      曲名.textContent = track.title
      const クレジット = document.createElement('p')
      クレジット.className = 'bgm-credit-credit'
      クレジット.textContent = track.credit
      const 板 = document.createElement('div')
      板.className = 'bgm-credit-card'
      板.append(曲名, クレジット)
      root.replaceChildren(板)
    },
  }
}
