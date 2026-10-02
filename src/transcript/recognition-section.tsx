/**
 * コネクターのページの Web Speech API の区画（issue #189）
 *
 * アプリの枠で動かす音声認識（recognition-context.tsx）のオン・オフと、いまの様子を出す。
 * 様子は、状態・話している途中の文・つなぎ直した回数と途切れた時間の合計・字幕の中継先へ送れているか・送った発話と記録できたかどうか。
 *
 * 認識そのものは枠が持つので、このページを離れても止まらない。止まってしまったときの理由と始め直しのボタンもここに出す
 * （マイクの許可を求め直すには、ボタンを押すことが要る場合がある）。
 *
 * 注意: 値を受け取って描くだけの RecognitionSectionView を分けているのは、テストで文脈を組み立てずに確かめるためである。
 */
import { RotateCw } from 'lucide-react'
import { useId } from 'react'
import { HelpButton } from '@/components/help-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { DeliveredLine, DeliveryState } from './delivery'
import { useRecognition, type RecognitionContextValue } from './recognition-context'
import { describeRecognition, formatDuration } from './recognition-label'
import { RecognitionDot } from './recognition-status'
import { useStallClock } from './use-stall-clock'

/** 送った発話に添える言葉 */
const STATE_LABELS: Readonly<Record<DeliveryState, string>> = {
  sending: '送信中',
  recorded: '記録',
  discarded: '配信外',
  failed: '送れませんでした',
}

const describeLine = (line: DeliveredLine): string => (line.error ? `${STATE_LABELS[line.state]}: ${line.error}` : STATE_LABELS[line.state])

/** 止まってしまった理由。鍵を取れなかったか、認識が止まったか、ブラウザに無いか */
const failureMessage = (value: RecognitionContextValue): string | null => {
  if (value.phase === 'unsupported') return 'このブラウザには音声認識がありません。Chrome で開いてください'
  if (value.phase === 'failed') return value.error
  if (value.phase === 'running' && value.recognizer.status.kind === 'failed') return value.recognizer.status.message
  return null
}

export const RecognitionSection = () => <RecognitionSectionView value={useRecognition()} />

export const RecognitionSectionView = ({ value }: { value: RecognitionContextValue }) => {
  const switchId = useId()
  const now = useStallClock(value.recognizer)
  const { label, tone } = describeRecognition(value, now)
  const failure = failureMessage(value)
  const { interim, restarts, interruptedMs } = value.recognizer

  return (
    <Card>
      <CardHeader>
        <CardTitle>Web Speech API</CardTitle>
        <CardAction>
          <HelpButton topic="Web Speech API">
            <p>Chrome の音声認識で配信者の声を文字にし、確定した発話を配信の記録（あらすじ・章立ての材料）に送ります。</p>
            <p>話している途中の文と確定した文は、オーバーレイの素材「字幕」にも送ります。</p>
            <p>認識するのは HDAD のページを開いている Chrome のタブです。どのページに移っても続きますが、タブを閉じると止まります。配信中は HDAD を別のウィンドウで開いたままにしてください。</p>
            <p>HDAD を2つ以上のタブで開いていても、認識するのは1つのタブだけです。そのタブを閉じると、ほかのタブが代わりに始めます。</p>
            <p>裏に回したタブが止められないよう、Chrome の設定の「パフォーマンス」で、このサイトを「常にアクティブにするサイト」に追加してください。</p>
          </HelpButton>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Switch id={switchId} checked={value.enabled} onCheckedChange={(checked) => value.setEnabled(checked)} />
          <Label htmlFor={switchId}>文字起こしする</Label>
          {value.enabled && (
            <span className="ml-auto flex items-center gap-2 text-sm">
              <RecognitionDot tone={tone} />
              {label}
            </span>
          )}
        </div>

        {failure && (
          <Alert variant="destructive">
            <AlertTitle>文字起こしが止まっています</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{failure}</p>
              {value.phase !== 'unsupported' && (
                <Button type="button" variant="outline" size="sm" onClick={value.restart}>
                  <RotateCw aria-hidden="true" />
                  もう一度始める
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {value.phase === 'running' && (
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">{`つなぎ直し ${restarts}回・途切れた時間 ${formatDuration(interruptedMs)}`}</p>
            {interim !== '' && <p className="text-muted-foreground italic">{interim}</p>}
            {value.captionWarning && <p className="text-destructive">{value.captionWarning}</p>}
            {value.translationWarning && <p className="text-destructive">{value.translationWarning}</p>}
          </div>
        )}

        {value.lines.length > 0 && (
          <ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
            {value.lines.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-3 border-b py-1 last:border-b-0">
                <span>{line.text}</span>
                <span className={line.state === 'failed' ? 'shrink-0 text-xs text-destructive' : 'shrink-0 text-xs text-muted-foreground'}>
                  {describeLine(line)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
