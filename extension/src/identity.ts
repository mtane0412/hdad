/**
 * 拡張のID
 *
 * Worker（worker/tab-routes.ts）は、送り手としてつないできた接続の Origin が chrome-extension://<このID> のときだけ受け付ける
 * （別のサイトや別の拡張が送り手を名乗り、配信画面へ別の映像を送り込めないようにするため）。
 *
 * パッケージ化されていない拡張のIDは、読み込んだフォルダの場所で変わってしまう。そこで manifest.json に公開鍵（key）を書いて
 * IDを固定してある。秘密鍵は持たない（ウェブストアに出さず、パッケージ化もしないので要らない）。
 *
 * 注意: key を書き換えたら、このIDも直す（extension/src/identity.test.ts が一致を確かめる）。
 */

/** manifest.json の key から Chrome が決めるID */
export const EXTENSION_ID = 'pnbbiagigelableeedldopbmgnkghjhm'
