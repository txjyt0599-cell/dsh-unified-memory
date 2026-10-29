/**
 * lib/scoring/importance.js —— 确定性的重要度打分（写卡时用）
 * [2026-10-24 by Assistant · 红白双队签字后的 Step 1]
 *
 * 为什么不用"让她自己感觉"：
 *   实测库里 5,735 张活卡有 5,097 张 importance=0.6 —— 写死不等于有分。
 *   改成**可核对的信号表**：命中什么信号加多少分，全部由文本特征判定，
 *   不依赖模型主观（模型觉得什么都重要 ⇒ 又回到 0.6）。
 *
 * 铁律（红队三条）：
 *   ① 只有**User的话**能拿高分的信号；Assistant自己转述/总结的算流水。
 *   ② 日常祈使句（"重启一下""帮我看看这个"）哪怕原话也只给基础分。
 *   ③ importance >= 0.80 或命中硬件/环境基石 ⇒ 自动 is_axiom（免时间衰减）。
 */

export const IMPORTANCE_BASE = 0.25;

/** 被User纠错 / 推翻（最高优先级：错过一次不能再错） */
const CORRECTION = /(纠正|错了|搞错|弄错|不对|改成|应该是|其实是|重新来|推翻|作废|撤回|别用|禁止|不要再用|(不是|并非)\s*[\d.]+\s*[GMK]?B?)/;
/** 明确的架构决定 / 约定 / 边界 / 铁律 */
const DECISION = /(以后都|从现在起|约定|定下来|铁律|原则|规矩|边界|不许|必须|永远|一律|决定|拍板|就这么定|优先级)/;
/** 长期偏好 / 环境基石 / 硬件事实 */
const AXIOMISH = /(16G|16 ?GB|9060|780M|4050|ROCm|HIP|前缀缓存|显存|硬件|主板|处理器|内存|驱动|版本锁|固定为|默认就)/i;
/** 情绪转折 / 关系里程碑 */
const EMOTION = /(心疼|舍不得|难过|开心|高兴|累|休息|陪|喜欢|想你|谢谢|对不起|抱歉|害怕|担心|温暖|记住我|一直)/;
/** 纯执行流水（这些一律不加分，哪怕字数很多） */
const ROUTINE = /^(好的|嗯|继续|收到|开始|可以|重启了|改了|修了|装好了|跑完了|完成了|搞定)/;

/** [2026-10-25 白队暗礁1+2治理] 精确区分两类排除词，杜绝误杀"带条件的铁律" */
// ① 真正被否决/推翻的死胡同结论（一票否决，绝不可成为基石）
const FATAL_EXCLUDE = /(被驳回|已撤回|旧结论失效|方案被否|放弃|不可行|跑不了|不能用)/;
// ② 普通过程工单/临时记录（但若带有硬铁律如"测试环境下绝对不准开启"，硬铁律优先豁免）
// [红队复核微调] 把单纯的"测试"收紧为"临时测试|正在测试|先测试"，防误杀环境铁律
const TRANSIENT_WORDS = /(未\s*build|临时测试|正在测试|先测试|实验记录|进度盘点|待做|待办|暂定|草案|小插曲|TODO|工单事项)/i;

/**
 * 打一条普通分：0.25 起，按信号叠加，封顶 1.0
 * @param {{text?:string, title?:string, summary?:string, content?:string, role?:string, source?:string}} input
 * @returns {{importance:number, is_axiom:boolean, signals:string[]}}
 */
export function scoreImportance(input) {
  const it = input || {};
  const text = String(it.text || [it.title, it.summary, it.content].filter(Boolean).join(' '));
  const signals = [];

  // [白队铁律] 只有人类输入才允许高级加分；Assistant自己的总结一律走基础分
  const fromUser = it.role === undefined ? true : String(it.role) === 'user';

  if (!text.trim()) return { importance: IMPORTANCE_BASE, is_axiom: false, signals: ['empty'] };
  if (ROUTINE.test(text.slice(0, 20))) {
    return { importance: IMPORTANCE_BASE, is_axiom: false, signals: ['routine'] };
  }

  let score = IMPORTANCE_BASE;

  if (fromUser) {
    if (CORRECTION.test(text)) { score += 0.40; signals.push('correction'); }
    if (DECISION.test(text)) { score += 0.30; signals.push('decision'); }
    if (AXIOMISH.test(text)) { score += 0.25; signals.push('axiom-ish'); }
    if (EMOTION.test(text)) { score += 0.15; signals.push('emotion'); }
  }

  // 同一条里既有纠错又有决定 ⇒ 只取最高一档，不叠满（防暴走）
  if (signals.includes('correction') && signals.includes('decision')) {
    score -= 0.10;
  }

  const importance = Math.min(1.0, Number(score.toFixed(2)));

  // ── [2026-10-25 白队终审治理] 基石卡收紧铁律 ──
  //   白队指出：1,448 张基石卡占总库 15%，严重偏高！工单/实验/死胡同混入基石会造成永不衰减霸榜。
  //   真正的基石只有三类：
  //     ① 铁律级硬决策（hardDecision：铁律/永远/一律/禁止/不许/绝不）
  //     ② 明确的物理硬件常数或更正公理（命中 AXIOMISH 且有物理事实断言，且 importance >= 0.8）
  //     ③ 显式指定的高纯度公理（it.is_axiom === true 且未被过程词污染）
  //   铁律护栏：任何命中 TRANSIENT_EXCLUDE（未build/尝试/驳回/撤回/失效等）一律不得自动授予 is_axiom！
  // ── [2026-10-25 白队暗礁1治理：铁律优先于普通过程词] ──
  //   白队指出：语义是复杂的。若用户说"在测试环境下，绝对不准开启XX功能，这是铁律"，
  //   不能因为命中了"测试"就把硬铁律一票误杀成普通卡！
  //   规则：死胡同词（驳回/撤回/不可行）永远一票否决；
  //         对于普通过程修饰词，若明确带有 hardDecision（铁律/永远/一律/禁止/绝不），
  //         硬铁律具有更高防线，允许作为条件铁律立为基石！
  const tHeader = String(it.title || '') + ' ' + String(it.summary || '').slice(0, 50);
  const isFatal = FATAL_EXCLUDE.test(tHeader);
  const isTransientWord = TRANSIENT_WORDS.test(tHeader);

  // ── [红队复核微调：通道2断言词去单字化 + 强戒律词完备] ──
  //   ① 杜绝单字"是/为"误判日常排障解释句（"插件报错是因为路径不对"）；
  //      收紧为双字以上定语词组（显存为|架构为|固定为|恒定为|物理显存|误报等），且排除因果解释词。
  //   ② 强戒律词扩充：补齐"严禁"、"永远禁止"，确保铁律判定绝对严密。
  const hasAxiomFact = fromUser && AXIOMISH.test(text)
    && /(真实物理显存|物理显存|显存为|架构为|固定为|恒定为|溢出误报|探针误报|误报|版本锁|不可动摇|更正|纠正|以\s*[\d.]+\s*[GMK]?B?\s*为准)/.test(text)
    && !/(因为|以为|听别人说)/.test(text)
    && importance >= 0.8;
  const hardDecision = signals.includes('decision') && /(铁律|永远|一律|禁止|不许|绝不|严禁|永远禁止)/.test(text);

  let is_axiom = false;
  if (!isFatal) {
    if (hardDecision) {
      // 只要未被显式废弃/驳回，硬铁律直接确立为基石（哪怕带了"测试环境"这类条件）
      is_axiom = true;
    } else if (!isTransientWord) {
      if (hasAxiomFact) {
        is_axiom = true;
      } else if (it.is_axiom === true && importance >= 0.9) {
        is_axiom = true;
      }
    }
  }

  return { importance, is_axiom, signals };
}

/** 给历史存量卡算一次（离线回填用） */
export function backfillCard(card) {
  const base = scoreImportance({
    title: card && card.title,
    summary: card && card.summary,
    content: card && card.content,
    role: 'user',
  });
  return Object.assign({}, card, {
    importance: base.importance,
    is_axiom: base.is_axiom || card.is_axiom === true,
    importance_signals: base.signals,
  });
}