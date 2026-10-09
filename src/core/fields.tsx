/**
 * パラメータの入力欄（スキーマから自動生成する）
 *
 * 素材のパラメータ宣言（src/core/params.ts のスキーマ）1件から、種類に合う入力欄を1つ描く。
 * 合成オーバーレイの管理画面（src/overlay/overlay-page.tsx）が、レイヤーごとの調整に使う。
 *
 * 注意: 値が書式に合うかどうかは合成ページ側が最後に確かめる（parseParams）。ここでは入力欄の見た目として
 * 知らせるだけで、書式に合わない文字列もそのまま呼び出し側へ渡す。
 */
import { Minus, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Slider } from '@/components/ui/slider'
import { iconButtonName } from './icon-button'
import type { AnyParamValue, BooleanParamSpec, ChoiceParamSpec, ColorParamSpec, ColorsParamSpec, NumberParamSpec, ParamSpec, StringParamSpec } from './params'

/** 小数パラメータのスライダーの刻み */
const DECIMAL_STEP = 0.05
/** 透過を解除したときに戻す色が既定値から得られない場合の色 */
const OPAQUE_FALLBACK_COLOR = '#000000'
/** 配色に色を追加するときの初期色 */
const ADDED_COLOR = '#ffffff'
const TRANSPARENT = 'transparent'

interface FieldProps<S extends ParamSpec> {
  name: string
  spec: S
  value: AnyParamValue
  onChange(value: AnyParamValue): void
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
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          {...iconButtonName('色を追加する')}
          disabled={colors.length >= spec.maxCount}
          onClick={() => onChange([...colors, ADDED_COLOR])}
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          {...iconButtonName('色を減らす')}
          disabled={colors.length <= spec.minCount}
          onClick={() => onChange(colors.slice(0, -1))}
        >
          <Minus aria-hidden="true" />
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

const ChoiceField = ({ name, spec, value, onChange }: FieldProps<ChoiceParamSpec>) => (
  <Field name={name} description={spec.description}>
    <NativeSelect className="w-full" aria-label={spec.description} value={String(value)} onChange={(event) => onChange(event.currentTarget.value)}>
      {spec.choices.map((choice) => (
        <NativeSelectOption key={choice.value} value={choice.value}>
          {choice.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  </Field>
)

/** スキーマの種類に合う入力欄を1つ描く */
export const ParamField = ({ name, spec, value, onChange }: FieldProps<ParamSpec>) => {
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
    case 'choice':
      return <ChoiceField name={name} spec={spec} value={value} onChange={onChange} />
  }
}
