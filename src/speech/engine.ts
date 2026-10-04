/**
 * 合成先の見分け
 *
 * 読み上げのページ（src/speech/task.ts）は、合成先（ローカルの VOICEVOX ENGINE か、さくらのAI Engine か）と
 * ローカルのつなぎ先（ホストとポート）を起動のときにしか使えない。設定を読み直したときに、OBSの再読み込みが要るほど
 * 変わったかをここで見分ける。
 *
 * 注意: さくらはホストとポートを使わない（Worker 経由で呼ぶ）ので、さくらを選んでいるあいだにホストとポートを変えても
 * 再読み込みは要らない。
 */
import type { SpeechSettings } from './api'

/**
 * 設定から、読み上げのページが起動のときに決めるつなぎ先を表す文字列を作る。
 *
 * 2つの設定でこれが違えば、OBSの再読み込みが要る。
 */
export const speechEndpointOf = ({ engine, host, port }: Pick<SpeechSettings, 'engine' | 'host' | 'port'>): string =>
  engine === 'sakura' ? 'sakura' : `local:${host}:${port}`
