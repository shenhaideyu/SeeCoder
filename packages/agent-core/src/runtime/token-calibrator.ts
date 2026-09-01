// ModelConfig 提供模型地址和名称，用于隔离不同模型的估算系数。
import type { ModelConfig } from '@seecoder/model';

// TokenCalibrator 用模型返回的真实 prompt usage 修正本地字符估算误差。
export class TokenCalibrator {
  // scales 按“服务地址 + 模型名”保存各自的校准倍率。
  private readonly scales = new Map<string, number>();

  // key 生成某个模型配置对应的稳定 Map 键。
  key(model: ModelConfig): string {
    // 空字符作为分隔符，避免地址末尾和模型开头拼接后产生歧义。
    return `${model.baseUrl}\0${model.model}`;
  } // 结束模型键生成方法。

  // scale 返回模型当前倍率；从未校准时使用中性倍率 1。
  scale(model: ModelConfig): number {
    // 先计算模型键，再从 Map 读取；空值合并只处理 undefined。
    return this.scales.get(this.key(model)) ?? 1;
  } // 结束倍率读取方法。

  // record 根据本次估算 token 和 Provider 返回的真实 token 更新平滑倍率。
  record(model: ModelConfig, estimatedTokens: number, actualTokens: number): number {
    // 任一数值无效时不更新，直接返回现有倍率，避免除零或负值污染状态。
    if (estimatedTokens <= 0 || actualTokens <= 0) return this.scale(model);
    // observed 是真实值与估算值之比，并限制在 0.5～4 之间抵抗异常 usage。
    const observed = Math.min(4, Math.max(0.5, actualTokens / estimatedTokens));
    // key 确保这次观测只影响当前服务和模型。
    const key = this.key(model);
    // previous 读取历史倍率；undefined 表示第一次得到真实 usage。
    const previous = this.scales.get(key);
    // 首次直接采用观测值；后续使用 80% 旧值和 20% 新值平滑波动。
    const next = previous === undefined ? observed : previous * 0.8 + observed * 0.2;
    // 保存新倍率，后续上下文预算会使用它修正估算。
    this.scales.set(key, next);
    // 返回刚刚写入的倍率，方便调用方记录快照。
    return next;
  } // 结束校准记录方法。

  // restore 从 Session 压缩快照恢复先前保存的模型倍率。
  restore(key: string, scale: number): void {
    // 只有键非空且倍率为有限数字时才恢复，并再次限制到安全范围。
    if (key && Number.isFinite(scale)) this.scales.set(key, Math.min(4, Math.max(0.5, scale)));
  } // 结束倍率恢复方法。
} // 结束 TokenCalibrator 类。
