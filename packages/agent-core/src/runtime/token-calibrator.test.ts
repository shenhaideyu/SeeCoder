// Vitest 提供测试分组、断言和单个测试用例函数。
import { describe, expect, it } from 'vitest';
// TokenCalibrator 是本文件要验证的“Token 估算校准器”。
import { TokenCalibrator } from './token-calibrator.js';

// 构造一份最小模型配置；测试不真正请求该地址或读取 API Key。
const model = {
  baseUrl: 'http://one', // 参与模型身份 key，表示服务端点。
  model: 'alpha', // 当前模型名，另一个模型名应使用独立校准值。
  apiKeyEnv: 'UNUSED', // 该单元测试不访问网络，因此只是满足类型要求。
  contextWindow: 10_000, // 模型最大上下文窗口。
  temperature: 0, // 与本测试逻辑无关的生成参数。
  maxOutputTokens: 1000, // 预留的最大输出 Token 数。
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
};

// 把 TokenCalibrator 的相关行为归入同一测试组。
describe('TokenCalibrator', () => {
  // 验证校准器能学习实际 usage、限制极端比例，并按模型隔离数据。
  it('learns from actual usage with a bounded moving average and isolates models', () => {
    // 每个用例创建新实例，避免其他测试留下的记录影响结果。
    const calibrator = new TokenCalibrator();
    // 从未记录过真实 usage 时，估算倍率应为中性的 1。
    expect(calibrator.scale(model)).toBe(1);
    // 估算 100、实际 200，第一次记录后倍率应学习为 2。
    expect(calibrator.record(model, 100, 200)).toBe(2);
    // 第二次实际比例为 1，移动平均只平滑下降到约 1.8，而不是立刻跳到 1。
    expect(calibrator.record(model, 100, 100)).toBeCloseTo(1.8);
    // beta 是另一个模型，不能继承 alpha 已学习到的 1.8。
    expect(calibrator.scale({ ...model, model: 'beta' })).toBe(1);
    // 估算值为 0 无法计算比例，因此应忽略样本并保持原倍率。
    expect(calibrator.record(model, 0, 100)).toBeCloseTo(1.8);
    // 极端 usage 样本也必须被上限夹住，避免上下文预算被永久放大。
    expect(calibrator.record(model, 100, 10_000)).toBeLessThanOrEqual(4);
    // restore 模拟从持久化快照恢复 beta 模型之前学到的倍率。
    calibrator.restore(calibrator.key({ ...model, model: 'beta' }), 1.6);
    // 恢复后读取 beta，应得到刚写入的 1.6。
    expect(calibrator.scale({ ...model, model: 'beta' })).toBe(1.6);
  }); // 结束校准学习与模型隔离测试。
}); // 结束 TokenCalibrator 测试组。
