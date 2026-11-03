import type { GpuTimingSource } from '../types.js';

interface TimestampSlot {
  readonly querySet: GPUQuerySet;
  readonly resolveBuffer: GPUBuffer;
  readonly readbackBuffer: GPUBuffer;
  busy: boolean;
}

export interface GpuFrameSample {
  readonly source: GpuTimingSource;
  readonly querySet?: GPUQuerySet;
  resolve(encoder: GPUCommandEncoder): void;
  read(submittedAt: number): Promise<number | undefined>;
  cancel(): void;
}

/** タイムスタンプの起点がリセットされた場合の負の差分は、制御に使わず捨てる。 */
export function timestampDurationMs(values: BigUint64Array): number | undefined {
  if (values.length < 2 || values[1] < values[0]) return undefined;
  const duration = Number(values[1] - values[0]) / 1_000_000;
  return Number.isFinite(duration) ? duration : undefined;
}

/**
 * 開始・終了の GPU 時刻を非同期に読む。待機中のスロットは再利用しない。
 * 非対応時と読み戻し失敗後は、キュー待ち・JS 通知遅延を含む粗い完了時間へ切り替える。
 */
export class GpuFrameTimer {
  private readonly slots: TimestampSlot[] = [];
  private timestampEnabled: boolean;
  private queueBusy = false;
  private disposed = false;

  constructor(private readonly device: GPUDevice) {
    this.timestampEnabled = device.features.has('timestamp-query');
    if (!this.timestampEnabled) return;
    // 各スロットは 2 時刻と 16 bytes の解決先・読み戻し先だけを持つ。点数には比例しない。
    for (let index = 0; index < 2; index++) {
      this.slots.push({
        querySet: device.createQuerySet({ label: 'frame-timestamps', type: 'timestamp', count: 2 }),
        resolveBuffer: device.createBuffer({
          label: 'frame-timestamp-resolve',
          size: 16,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        }),
        readbackBuffer: device.createBuffer({
          label: 'frame-timestamp-readback',
          size: 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
      });
    }
  }

  get allocatedBufferBytes(): number {
    return this.slots.reduce(
      (sum, slot) => sum + slot.resolveBuffer.size + slot.readbackBuffer.size,
      0
    );
  }

  beginFrame(): GpuFrameSample | undefined {
    if (this.disposed) return undefined;
    if (!this.timestampEnabled) return this.beginQueueSample();
    const slot = this.slots.find((candidate) => !candidate.busy);
    if (!slot) return undefined;
    slot.busy = true;
    return {
      source: 'timestamp-query',
      querySet: slot.querySet,
      resolve: (encoder) => {
        encoder.resolveQuerySet(slot.querySet, 0, 2, slot.resolveBuffer, 0);
        encoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readbackBuffer, 0, 16);
      },
      read: async () => {
        try {
          await slot.readbackBuffer.mapAsync(GPUMapMode.READ);
          if (this.disposed || !this.timestampEnabled) return undefined;
          return timestampDurationMs(new BigUint64Array(slot.readbackBuffer.getMappedRange()));
        } catch (error) {
          if (this.disposed || !this.timestampEnabled) return undefined;
          this.disableTimestamps();
          throw error;
        } finally {
          if (slot.readbackBuffer.mapState === 'mapped') slot.readbackBuffer.unmap();
          slot.busy = false;
        }
      },
      cancel: () => {
        slot.busy = false;
      },
    };
  }

  private beginQueueSample(): GpuFrameSample | undefined {
    if (this.queueBusy) return undefined;
    this.queueBusy = true;
    return {
      source: 'queue',
      resolve: () => {
        // キュー方式には、コマンドへ追加するタイムスタンプの解決処理がない。
      },
      read: async (submittedAt) => {
        try {
          await this.device.queue.onSubmittedWorkDone();
          return this.disposed ? undefined : performance.now() - submittedAt;
        } catch (error) {
          if (!this.disposed) throw error;
          return undefined;
        } finally {
          this.queueBusy = false;
        }
      },
      cancel: () => {
        this.queueBusy = false;
      },
    };
  }

  private disableTimestamps(): void {
    this.timestampEnabled = false;
    for (const slot of this.slots) {
      slot.querySet.destroy();
      slot.resolveBuffer.destroy();
      slot.readbackBuffer.destroy();
    }
    this.slots.length = 0;
  }

  destroy(): void {
    this.disposed = true;
    this.disableTimestamps();
  }
}
