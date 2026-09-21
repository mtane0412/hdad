/**
 * ギャラリー（壁紙・時計・チャットボックスの一覧ページ）
 *
 * レジストリの素材を一覧し、スキーマから調整用の入力欄を自動生成する。
 * 入力のたびにプレビューとOBS用URLを更新する。選択中の素材はURLのハッシュ（#contour など）に保持する。
 * アプリのルート（src/app/pages.tsx）から、カテゴリごとのレジストリを渡して使う。
 *
 * 注意: ハッシュが登録されていないIDを指していたら、先頭の素材に置き換えずエラーとして伝える（Fail-Fast）。
 * 書式に合わない文字列もそのままURLへ反映する（素材ページ側がエラーとして表示する）。
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import type { BackgroundDefinition } from '../background'
import type { BooleanParamSpec, ColorParamSpec, ColorsParamSpec, NumberParamSpec, ParamSpec, StringParamSpec } from '../params'
import { buildBackgroundUrl } from './url'

type Value = number | string | boolean | readonly string[]
type Values = Record<string, Value>

/** 入力中にプレビューを再読み込みしすぎないための待ち時間（ミリ秒） */
const PREVIEW_DELAY_MS = 150
/** 小数パラメータのスライダーの刻み */
const DECIMAL_STEP = 0.05
/** 透過を解除したときに戻す色が既定値から得られない場合の色 */
const OPAQUE_FALLBACK_COLOR = '#000000'
/** 配色に色を足すときの初期色 */
const ADDED_COLOR = '#ffffff'
const TRANSPARENT = 'transparent'

/** ギャラリーが素材について知る必要のある項目（描画方法には関知しない） */
export type GalleryItem = Pick<BackgroundDefinition, 'id' | 'title' | 'description' | 'schema'>

/** ギャラリーに表示する対象の指定 */
export interface GalleryTarget {
  /** そのカテゴリのレジストリ */
  readonly definitions: readonly GalleryItem[]
  /** 案内文で素材を指す呼び名（「背景」「時計」など） */
  readonly noun: string
  /** そのカテゴリの公開ディレクトリのパス（/wallpaper/ など）。素材ページはこの下の <id>/ にある */
  readonly basePath: string
  /** プレビューの実寸（OBSのブラウザソースに設定する大きさ。px） */
  readonly previewSize: { readonly width: number; readonly height: number }
  /**
   * プレビューにだけ適用するパラメータ値。OBS用のURLには影響しない。
   * チャットのように、本番では外部へ接続する素材を、プレビューではサンプル表示にするために使う。
   */
  readonly previewOverrides?: Readonly<Record<string, Value>>
}

const defaultsOf = (definition: GalleryItem): Values =>
  Object.fromEntries(Object.entries(definition.schema).map(([name, spec]) => [name, spec.default]))

const subscribeToHash = (onChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** ハッシュを素材IDとして読む。% だけのようにデコードできないハッシュは、そのままの文字列を返して「登録されていないID」として扱わせる */
const readHashId = (): string => {
  const raw = window.location.hash.slice(1)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** URLのハッシュが指す素材ID（ハッシュなしは空文字） */
const useHashId = (): string => useSyncExternalStore(subscribeToHash, readHashId)

/** 値の変化が delay ミリ秒のあいだ止まってから、その値を返す */
const useSettled = <T,>(value: T, delay: number): T => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return settled
}

interface FieldProps<S extends ParamSpec> {
  name: string
  spec: S
  value: Value
  onChange(value: Value): void
}

/** 入力欄1つ分の枠。見出しに説明とパラメータ名（URLに書く名前）を出す */
const Field = ({ name, description, labelId, children }: { name: string; description: string; labelId?: string; children: React.ReactNode }) => (
  <fieldset className="flex flex-col gap-2">
    <legend className="mb-2 flex w-full items-baseline justify-between gap-2 text-sm font-medium">
      <span id={labelId}>{description}</span>
      <code className="font-mono text-xs text-muted-foreground">{name}</code>
    </legend>
    {children}
  </fieldset>
)

const ColorInput = ({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange(color: string): void }) => (
  <input
    type="color"
    aria-label={label}
    value={value}
    disabled={disabled}
    onChange={(event) => onChange(event.currentTarget.value)}
    className="h-8 w-12 cursor-pointer rounded-md border border-input bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
  />
)

const NumberField = ({ name, spec, value, onChange }: FieldProps<NumberParamSpec>) => {
  const labelId = useId()
  return (
    <Field name={name} description={spec.description} labelId={labelId}>
      <div className="flex items-center gap-3">
        <Slider
          aria-labelledby={labelId}
          min={spec.min}
          max={spec.max}
          step={spec.integer ? 1 : DECIMAL_STEP}
          value={[Number(value)]}
          onValueChange={(next) => onChange(Array.isArray(next) ? (next[0] ?? spec.default) : next)}
        />
        <output className="w-12 text-right font-mono text-xs tabular-nums">{String(value)}</output>
      </div>
    </Field>
  )
}

const ColorField = ({ name, spec, value, onChange }: FieldProps<ColorParamSpec>) => {
  const checkLabelId = useId()
  const isTransparent = value === TRANSPARENT
  // 透過を解除したときに戻す色。透過にする前に選んでいた色を覚えておく
  const [opaque, setOpaque] = useState(() => {
    if (!isTransparent) return String(value)
    return spec.default === TRANSPARENT ? OPAQUE_FALLBACK_COLOR : spec.default
  })
  return (
    <Field name={name} description={spec.description}>
      <div className="flex items-center gap-3">
        <ColorInput
          label={spec.description}
          value={opaque}
          disabled={isTransparent}
          onChange={(color) => {
            setOpaque(color)
            onChange(color)
          }}
        />
        {spec.allowTransparent && (
          <Label>
            <Checkbox aria-labelledby={checkLabelId} checked={isTransparent} onCheckedChange={(checked) => onChange(checked ? TRANSPARENT : opaque)} />
            <span id={checkLabelId}>透過にする</span>
          </Label>
        )}
      </div>
    </Field>
  )
}

const ColorsField = ({ name, spec, value, onChange }: FieldProps<ColorsParamSpec>) => {
  const colors = Array.isArray(value) ? value : spec.default
  return (
    <Field name={name} description={spec.description}>
      <div className="flex flex-wrap items-center gap-2">
        {colors.map((color, index) => (
          <ColorInput
            // 色は順番でしか区別できないので、位置をキーにする
            key={index}
            label={`${spec.description} ${index + 1}色目`}
            value={color}
            onChange={(picked) => onChange(colors.map((other, position) => (position === index ? picked : other)))}
          />
        ))}
        <Button type="button" variant="outline" size="sm" disabled={colors.length >= spec.maxCount} onClick={() => onChange([...colors, ADDED_COLOR])}>
          色を足す
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={colors.length <= spec.minCount} onClick={() => onChange(colors.slice(0, -1))}>
          色を減らす
        </Button>
      </div>
    </Field>
  )
}

const BooleanField = ({ name, spec, value, onChange }: FieldProps<BooleanParamSpec>) => {
  const labelId = useId()
  return (
    <Field name={name} description={spec.description} labelId={labelId}>
      <Label>
        <Checkbox aria-labelledby={labelId} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
        <span aria-hidden="true">有効にする</span>
      </Label>
    </Field>
  )
}

const StringField = ({ name, spec, value, onChange }: FieldProps<StringParamSpec>) => {
  const hintId = useId()
  const text = String(value)
  const acceptable = text === spec.default || spec.pattern.test(text)
  return (
    <Field name={name} description={spec.description}>
      <Input
        type="text"
        aria-label={spec.description}
        aria-invalid={!acceptable}
        aria-describedby={acceptable ? undefined : hintId}
        value={text}
        placeholder={spec.example}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {!acceptable && (
        <p id={hintId} className="text-xs text-destructive">
          書式に合いません（例: {spec.example}）
        </p>
      )}
    </Field>
  )
}

const ParamField = ({ name, spec, value, onChange }: FieldProps<ParamSpec>) => {
  switch (spec.type) {
    case 'number':
      return <NumberField name={name} spec={spec} value={value} onChange={onChange} />
    case 'color':
      return <ColorField name={name} spec={spec} value={value} onChange={onChange} />
    case 'colors':
      return <ColorsField name={name} spec={spec} value={value} onChange={onChange} />
    case 'boolean':
      return <BooleanField name={name} spec={spec} value={value} onChange={onChange} />
    case 'string':
      return <StringField name={name} spec={spec} value={value} onChange={onChange} />
  }
}

/** プレビュー。iframe は実寸で描画し、表示枠の幅に合わせて縮小する */
const Preview = ({ url, title, size }: { url: string; title: string; size: GalleryTarget['previewSize'] }) => {
  const screenRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)

  useEffect(() => {
    const screen = screenRef.current
    if (!screen) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / size.width)
    })
    observer.observe(screen)
    return () => observer.disconnect()
  }, [size.width])

  return (
    <div
      ref={screenRef}
      // 実寸より大きく引き伸ばすと文字や線がぼやけるため、表示枠は実寸の幅までにする。市松模様は透過の背景を見分けるため
      className="relative w-full overflow-hidden rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-size-[24px_24px]"
      style={{ aspectRatio: `${size.width} / ${size.height}`, maxWidth: size.width }}
    >
      <iframe
        // src を書き換えるとブラウザの履歴が積まれるため、URLが変わるたびに iframe ごと作り直す
        key={url}
        src={url}
        title={title}
        width={size.width}
        height={size.height}
        className="absolute top-0 left-0 origin-top-left border-0"
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  )
}

type CopyResult = 'copied' | 'failed'

const COPY_MESSAGES: Record<CopyResult, string> = {
  copied: 'URLをコピーしました。OBSの「ソース > ブラウザ」のURL欄に貼り付けてください。',
  failed: 'URLをコピーできませんでした。URL欄を選択したので、手動でコピーしてください。',
}

/** 選んだ素材の調整（入力欄・プレビュー・OBS用URL）。素材を切り替えたら key で作り直し、値を既定値に戻す */
const Editor = ({ definition, target }: { definition: GalleryItem; target: GalleryTarget }) => {
  const { noun, basePath, previewSize, previewOverrides } = target
  const [values, setValues] = useState(() => defaultsOf(definition))
  // 「既定値に戻す」のたびに入力欄を作り直し、入力欄が覚えている内容（透過にする前の色）も捨てる
  const [resetCount, setResetCount] = useState(0)
  // どのURLをコピーした結果かを覚えておき、値が変わったら案内を消す
  const [copy, setCopy] = useState<{ url: string; result: CopyResult }>()
  const urlFieldRef = useRef<HTMLInputElement>(null)
  const urlFieldId = useId()

  const galleryUrl = new URL(basePath, window.location.origin).href
  const url = buildBackgroundUrl(galleryUrl, definition.id, definition.schema, values)
  const previewUrl = useSettled(
    previewOverrides ? buildBackgroundUrl(galleryUrl, definition.id, definition.schema, { ...values, ...previewOverrides }) : url,
    PREVIEW_DELAY_MS,
  )

  const copyUrl = (): void => {
    const fail = (): void => {
      urlFieldRef.current?.select()
      setCopy({ url, result: 'failed' })
    }
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる。
    // 型定義上は常に存在する扱いだが、実行時には無い場合があるので確認する
    if (!navigator.clipboard) {
      fail()
      return
    }
    navigator.clipboard.writeText(url).then(() => setCopy({ url, result: 'copied' }), fail)
  }

  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">{definition.title}</h2>
          <p className="text-sm text-muted-foreground">{definition.description}</p>
        </div>
        <Preview url={previewUrl} title={`${noun}のプレビュー`} size={previewSize} />
        <div className="flex flex-col gap-2">
          <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
          <div className="flex gap-2">
            <Input ref={urlFieldRef} id={urlFieldId} readOnly value={url} className="font-mono" />
            <Button type="button" onClick={copyUrl}>
              URLをコピー
            </Button>
          </div>
          <p role="status" className="min-h-5 text-sm text-muted-foreground">
            {copy?.url === url ? COPY_MESSAGES[copy.result] : ''}
          </p>
        </div>
      </div>
      <Card className="self-start">
        <CardHeader>
          <CardTitle>調整</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {Object.entries(definition.schema).map(([name, spec]) => (
            <ParamField
              key={`${name}-${resetCount}`}
              name={name}
              spec={spec}
              value={values[name] ?? spec.default}
              onChange={(value) => setValues((current) => ({ ...current, [name]: value }))}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setValues(defaultsOf(definition))
              setResetCount((count) => count + 1)
            }}
          >
            既定値に戻す
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * ギャラリーを描く。
 *
 * @throws レジストリが空の場合
 */
export const Gallery = (target: GalleryTarget) => {
  const { definitions, noun } = target
  const hashId = useHashId()

  const [first] = definitions
  if (!first) throw new Error(`レジストリに${noun}が1つも登録されていません`)
  // ハッシュなしは先頭の素材。登録されていないIDは undefined のままにして、エラーとして伝える
  const current = hashId === '' ? first : definitions.find((candidate) => candidate.id === hashId)

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <nav aria-label={`${noun}の一覧`} className="lg:w-40 lg:shrink-0">
        <ul className="flex flex-wrap gap-1 lg:flex-col">
          {definitions.map((definition) => (
            <li key={definition.id}>
              <Button
                type="button"
                variant={definition.id === current?.id ? 'secondary' : 'ghost'}
                size="sm"
                className="w-full justify-start"
                aria-current={definition.id === current?.id ? 'true' : undefined}
                onClick={() => {
                  window.location.hash = definition.id
                }}
              >
                {definition.title}
              </Button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        {current ? (
          <Editor key={current.id} definition={current} target={target} />
        ) : (
          <Alert variant="destructive">
            <AlertTitle>
              {noun}「{hashId}」は登録されていません
            </AlertTitle>
            <AlertDescription>一覧から{noun}を選んでください。</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  )
}
