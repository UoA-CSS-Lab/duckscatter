import { useState, useCallback } from 'react';

interface SliderProps {
  /** ラベルテキスト */
  label: string;
  /** 最小値 */
  min: number;
  /** 最大値 */
  max: number;
  /** ステップ値 */
  step: number;
  /** 初期値 */
  defaultValue: number;
  /** 値変更時のコールバック */
  onChange: (value: number) => void;
  /** 値のパース関数（デフォルト: parseFloat） */
  parseValue?: (v: string) => number;
  /** 表示用のフォーマット関数（デフォルト: 小数点2桁） */
  formatValue?: (v: number) => string;
  /** 左端のラベル */
  minLabel?: string;
  /** 右端のラベル */
  maxLabel?: string;
}

/**
 * 汎用スライダーコンポーネント
 */
export function Slider({
  label,
  min,
  max,
  step,
  defaultValue,
  onChange,
  parseValue = parseFloat,
  formatValue = (v) => v.toFixed(2),
  minLabel,
  maxLabel,
}: SliderProps) {
  const [value, setValue] = useState(defaultValue);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseValue(e.target.value);
      setValue(newValue);
      onChange(newValue);
    },
    [onChange, parseValue]
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">
        {label}: {formatValue(value)}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
      />
      {(minLabel || maxLabel) && (
        <div className="flex justify-between text-xs text-zinc-500">
          <span>{minLabel ?? min}</span>
          <span>{maxLabel ?? max}</span>
        </div>
      )}
    </div>
  );
}
