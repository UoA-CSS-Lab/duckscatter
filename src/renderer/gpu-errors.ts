import { createError } from '../errors.js';
import type { ScatterPlotError } from '../types.js';

/** GPU を利用できない CLI でも、コンパイル診断の整形を独立して検証できる値の形式。 */
export interface ShaderMessage {
  type: 'error' | 'warning' | 'info';
  message: string;
  lineNum: number;
  linePos: number;
}

/** 初期化の失敗を既存の error イベントへ、種類を失わずに伝えるための例外。 */
export class WebGPUInitializationError extends Error {
  constructor(public readonly diagnostic: ScatterPlotError) {
    super(diagnostic.message, { cause: diagnostic.cause });
    this.name = 'WebGPUInitializationError';
  }
}

/** GPUError は通常の Error を継承しないため、message を持つ値も取り出す。 */
export function gpuErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

/** エラーのあるシェーダー名・行・列・該当ソースをまとめ、警告だけなら失敗にしない。 */
export function shaderCompilationError(
  label: string,
  code: string,
  messages: readonly ShaderMessage[]
): ScatterPlotError | null {
  const errors = messages.filter((message) => message.type === 'error');
  if (errors.length === 0) return null;
  const lines = code.split('\n');
  const details = errors.map((message) => {
    const location = message.lineNum > 0 ? `${message.lineNum}:${message.linePos}` : 'unknown';
    const source = lines[message.lineNum - 1];
    return `${label}:${location}: ${message.message}${source === undefined ? '' : `\n${source}`}`;
  });
  return createError('GPU_SHADER_FAILED', `Shader compilation failed:\n${details.join('\n')}`, {
    context: {
      shader: label,
      // Web API の属性は prototype 上にあるため、spread でなく値を明示的に取り出す。
      messages: messages.map(({ type, message, lineNum, linePos }) => ({
        type,
        message,
        lineNum,
        linePos,
      })),
    },
  });
}
