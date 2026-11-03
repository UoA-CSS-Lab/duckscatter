import { createError } from '../errors.js';
import type { ScatterPlotError } from '../types.js';

/**
 * WebGPUコンテキストを管理するクラス
 */
export class WebGPUContext {
  /** GPUデバイスインスタンス */
  public device: GPUDevice | null = null;
  /** キャンバスのWebGPUコンテキスト */
  public context: GPUCanvasContext | null = null;
  /** テクスチャフォーマット */
  public format: GPUTextureFormat = 'bgra8unorm';
  private disposed = false;
  private readonly reportedErrors = new Set<string>();

  constructor(private readonly onError?: (error: ScatterPlotError) => void) {}

  /** 毎フレーム繰り返す同じ GPU エラーで、利用側の通知が埋まらないようにする。 */
  reportError(error: ScatterPlotError): void {
    if (this.disposed) return;
    const key = `${error.code}:${error.message}`;
    if (this.reportedErrors.has(key)) return;
    // メッセージが変化し続けても、診断用のキャッシュは一定件数に抑える。
    if (this.reportedErrors.size >= 32) {
      const oldest = this.reportedErrors.values().next().value;
      if (oldest !== undefined) this.reportedErrors.delete(oldest);
    }
    this.reportedErrors.add(key);
    if (this.onError) this.onError(error);
    else {
      // eslint-disable-next-line no-console
      console.warn('[duckscatter]', `${error.code}: ${error.message}`);
    }
  }

  /** エラーを画面へ渡しても、ブラウザ自身のコンソール出力は抑制しない。 */
  private readonly onUncapturedError = (event: GPUUncapturedErrorEvent): void => {
    this.reportError(
      createError(
        'GPU_UNCAPTURED_ERROR',
        `${event.error.constructor.name}: ${event.error.message}`,
        {
          context: { errorType: event.error.constructor.name },
        }
      )
    );
  };

  /**
   * WebGPUを初期化する
   * @param canvas 描画対象のHTMLCanvasElement
   */
  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    this.disposed = false;
    this.reportedErrors.clear();
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU is not supported in this browser. ' +
          'Please use Chrome 113+, Edge 113+, or Safari 18+ with WebGPU enabled.'
      );
    }

    let adapter: GPUAdapter | null = null;

    try {
      adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });
    } catch {
      // empty
    }

    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch {
        // empty
      }
    }

    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter({
          powerPreference: 'low-power',
        });
      } catch {
        // empty
      }
    }

    if (!adapter) {
      throw new Error(
        'Failed to get GPU adapter. Possible reasons:\n' +
          '1. WebGPU is disabled in browser flags\n' +
          '2. Your GPU is blocklisted\n' +
          '3. GPU drivers need updating\n' +
          '4. Running in a virtual machine without GPU access\n\n' +
          'For Chrome/Edge: Visit chrome://gpu to check WebGPU status\n' +
          'For Safari: Ensure macOS Sonoma 14.4+ with Safari 18+'
      );
    }

    try {
      this.device = await adapter.requestDevice();
    } catch (e) {
      throw new Error(`Failed to get GPU device: ${e}`, { cause: e });
    }

    if (!this.device) {
      throw new Error('Failed to get GPU device: Device is null');
    }

    const device = this.device;
    device.addEventListener('uncapturederror', this.onUncapturedError);
    void device.lost.then((info) => {
      // destroy() や新しいデバイスへの切り替えで生じた、古いデバイスの通知は捨てる。
      if (this.device !== device || this.disposed) return;
      device.removeEventListener('uncapturederror', this.onUncapturedError);
      this.device = null;
      this.reportError(
        createError('GPU_DEVICE_LOST', `GPU device lost (${info.reason}): ${info.message}`, {
          context: { reason: info.reason },
        })
      );
    });

    this.context = canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }

    this.format = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });
  }

  /**
   * WebGPUリソースを破棄する
   */
  destroy(): void {
    this.disposed = true;
    const device = this.device;
    this.device = null;
    if (device) {
      device.removeEventListener('uncapturederror', this.onUncapturedError);
      device.destroy();
    }
    this.reportedErrors.clear();
    this.context = null;
  }
}
