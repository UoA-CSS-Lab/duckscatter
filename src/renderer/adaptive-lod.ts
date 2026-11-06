import { DEFAULT_TARGET_RENDER_TIME_MS } from '../constants.js';

/** 連続値を追いかけず、同じ段階では同じ点を残す。低い保持率でも段階幅を保つ。 */
const KEEP_RATIOS = [
  0.0001, 0.00015, 0.0002, 0.0003, 0.0004, 0.0006, 0.0008, 0.001, 0.0015, 0.002, 0.003, 0.004,
  0.006, 0.008, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1,
] as const;
// 計測前から点を落とさず、実際に時間超過が確認できた場合だけ間引く。
const INITIAL_LEVEL = KEEP_RATIOS.length - 1;
const UPDATE_INTERVAL_MS = 500;

/** 移動のたびに停止期限を延ばし、パン・ズーム中の点集合の切り替えを抑える。 */
export class LodViewMotion {
  private settleAt = -Infinity;

  moved(nowMs: number): void {
    this.settleAt = nowMs + 200;
  }

  delay(nowMs: number): number {
    return Math.max(0, this.settleAt - nowMs);
  }

  reset(): void {
    this.settleAt = -Infinity;
  }
}

export interface LodAdjustment {
  readonly changed: boolean;
  readonly needsMoreSamples: boolean;
  /** 保持率を短時間に何度も切り替えないため、次の計測まで待つ時間。 */
  readonly retryAfterMs?: number;
}

/**
 * 点数の上限ではなく、計測時間から LOD の保持率を決める。
 * 同じ保持率で描いた結果だけを受け取り、遅れて届いた古い保持率の計測は使わない。
 */
export class AdaptiveLodController {
  private level = INITIAL_LEVEL;
  private targetMs: number;
  private readonly recentCosts: number[] = [];
  private smoothedCost: number | undefined;
  private nextUpdateAt = -Infinity;

  constructor(targetRenderTimeMs = DEFAULT_TARGET_RENDER_TIME_MS) {
    this.validateTarget(targetRenderTimeMs);
    this.targetMs = targetRenderTimeMs;
  }

  get keepRatio(): number {
    return KEEP_RATIOS[this.level];
  }

  get targetRenderTimeMs(): number {
    return this.targetMs;
  }

  setTargetRenderTimeMs(value: number): void {
    this.validateTarget(value);
    if (value === this.targetMs) return;
    this.targetMs = value;
    this.invalidateMeasurements();
  }

  /** データ・解像度・目標時間が変わったときは、以前の処理単価を持ち越さない。 */
  invalidateMeasurements(preserveUpdateInterval = false): void {
    this.recentCosts.length = 0;
    this.smoothedCost = undefined;
    if (!preserveUpdateInterval) this.nextUpdateAt = -Infinity;
  }

  /** 別のデータを初期表示するときも、全点を保持して計測を始める。 */
  reset(): void {
    this.level = INITIAL_LEVEL;
    this.invalidateMeasurements();
  }

  observe(durationMs: number, sampledKeepRatio: number, nowMs: number): LodAdjustment {
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      !Number.isFinite(nowMs) ||
      sampledKeepRatio !== this.keepRatio
    ) {
      return { changed: false, needsMoreSamples: false };
    }
    const cost = durationMs / sampledKeepRatio;
    if (!Number.isFinite(cost)) return { changed: false, needsMoreSamples: false };

    // 保持率の変更前後で平均を混ぜられるよう、時間を保持率あたりの処理単価にする。
    // 直近 3 件の中央値と平滑化で、一時的な負荷や通知遅延による急変を抑える。
    this.recentCosts.push(cost);
    if (this.recentCosts.length > 3) this.recentCosts.shift();
    if (this.recentCosts.length < 3 || nowMs < this.nextUpdateAt) {
      const retryAfterMs = Math.max(0, this.nextUpdateAt - nowMs);
      return { changed: false, needsMoreSamples: true, retryAfterMs };
    }
    const median = [...this.recentCosts].sort((a, b) => a - b)[1];
    this.smoothedCost =
      this.smoothedCost === undefined ? median : this.smoothedCost * 0.5 + median * 0.5;

    const ratio = this.keepRatio;
    const estimatedMs = this.smoothedCost * ratio;
    let nextLevel = this.level;
    if (estimatedMs > this.targetMs * 1.2 && this.level > 0) {
      // 20% の超過が続く場合だけ下げる。小さな時間差で点集合を切り替えない。
      const desiredRatio = ratio * ((this.targetMs * 0.9) / estimatedMs);
      nextLevel = this.level - 1;
      while (nextLevel > 0 && KEEP_RATIOS[nextLevel] > desiredRatio) nextLevel--;
    } else {
      // 一段上げた後も 20% の余裕が見込める場合に限って増やす。
      // 下げる条件と離しておき、隣接する段階の往復を防ぐ。
      for (let level = KEEP_RATIOS.length - 1; level > this.level; level--) {
        if (this.smoothedCost * KEEP_RATIOS[level] <= this.targetMs * 0.8) {
          nextLevel = level;
          break;
        }
      }
    }

    if (nextLevel === this.level) {
      const canDecrease = durationMs > this.targetMs * 1.2 && this.level > 0;
      const nextRatio = KEEP_RATIOS[this.level + 1];
      const canIncrease =
        nextRatio !== undefined && durationMs * (nextRatio / ratio) <= this.targetMs * 0.8;
      return { changed: false, needsMoreSamples: canDecrease || canIncrease };
    }

    this.level = nextLevel;
    this.recentCosts.length = 0;
    this.smoothedCost = undefined;
    this.nextUpdateAt = nowMs + UPDATE_INTERVAL_MS;
    return { changed: true, needsMoreSamples: false };
  }

  private validateTarget(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('targetRenderTimeMs must be a finite positive number');
    }
  }
}
