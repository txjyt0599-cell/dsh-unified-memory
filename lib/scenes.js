/**
 * lib/scenes.js —— 场景隔离（2026-10-28 · 补对标清单里"没有硬隔离"那条）
 *
 * ## 我们缺什么、不缺什么
 * 对比淋雨家（15 场景 / 27 项目 / 每个场景有身份卡和"谁的地盘"）：
 *   ✅ 我们**有**的：每张卡带 sessionId（实测近 300 条里 299 条有，16 个会话）
 *   ✅ 检索**有**：recentCrossSession / recentRounds 支持 excludeSessionId
 *   ❌ 缺的：**场景（scene）这一层抽象** —— 现在只有"会话"，没有"这类活归谁"
 *
 * ## 为什么不能直接用 sessionId 当场景
 *   会话是**一次性的**（换会话=换 id），场景是**长期的**（B 站看视频、电脑清理、视频工作流…）。
 *   用 sessionId 隔离 ⇒ 每换一次会话，历史就断一次。场景必须能跨会话累积。
 *
 * ## 本模块的三条设计决定
 *   ① **场景靠显式声明，不靠猜**：由 WORKSPACE 路径 / 显式参数 / 名字前缀决定，
 *      绝不从对话内容推断（猜错比不隔离更糟）。
 *   ② **默认不隔离**：未声明场景 = 全局可见。隔离是**选择加入**，不是默认拒绝——
 *      否则历史记忆会因为"没标场景"而集体消失。
 *   ③ **只做读侧过滤**：本模块不决定卡片存哪（那是 ingest 的事），
 *      只回答"这条查询该看到哪些卡"。
 */

/**
 * 场景目录（**示例值，请按自己的目录改**）
 *
 * 这些都是路径前缀。sceneOfCwd() 会把 cwd 与它们比前缀，命中第一个所属场景。
 * 没列出的路径走兜底规则（返回 null = 未声明场景，所有卡都可见）。
 *
 * ⚠️ 默认值刻意写成中性的通用路径，不绑定任何特定机器。
 *    想用场景隔离，把下面改成你自己的目录即可。
 */
export const SCENE_ROOTS = Object.freeze({
  'memory-plugin': ['/opt/unified-memory'],
  'desktop-pet': ['/opt/desktop-pet'],
  'video': ['/opt/video-tools'],
  'kvm': ['kvm', 'hub', 'nexthub'],
  'hub': ['/opt/hub'],
});

/**
 * 从工作目录推断场景。**只做路径前缀匹配，不做语义猜测。**
 * @param {string} cwd
 * @returns {string|null} 场景 id 或 null（表示"未声明"）
 */
export function sceneOfCwd(cwd) {
  const p = String(cwd || '').replace(/\\/g, '/').toLowerCase();
  if (!p) return null;
  // 最长前缀优先（避免 'd:/Assistant studio/hub' 被 'd:/Assistant studio' 抢走）
  let best = null, bestLen = 0;
  for (const [scene, roots] of Object.entries(SCENE_ROOTS)) {
    for (const r of roots) {
      const k = r.toLowerCase();
      if (p.startsWith(k) || p.includes(k)) {
        if (k.length > bestLen) { best = scene; bestLen = k.length; }
      }
    }
  }
  return best;
}

/**
 * 判断一条卡片属于哪个场景。
 * 判据优先级（**从确定到模糊**）：
 *   ① 卡上显式 scene 字段
 *   ② 卡上 cwd / workspace 推断
 *   ③ null（未声明）
 * ⛔ 绝不从 title/content 关键词猜场景 —— 那会把"Assistant桌宠"的卡塞进"记忆系统"。
 */
export function sceneOfCard(card) {
  const c = card || {};
  if (c.scene) return String(c.scene);
  if (c.cwd) return sceneOfCwd(c.cwd);
  if (c.workspace) return sceneOfCwd(c.workspace);
  return null;
}

/**
 * 过滤：给定当前场景，这条卡该不该被看到。
 *
 * 规则（保守，宁可见多不可见少）：
 *   · 当前场景未声明（null）⇒ **全部可见**（不隔离）
 *   · 卡未声明场景（null）⇒ **可见**（未标场景的历史卡不该消失）
 *   · 两边都声明且相同 ⇒ 可见
 *   · 两边都声明但不同 ⇒ **隔离**（这是唯一会挡的情况）
 *   · 显式 includeCrossScene ⇒ 全部可见
 *
 * @param {object} card
 * @param {string|null} currentScene
 * @param {object} [opts] { includeCrossScene }
 * @returns {boolean}
 */
export function isVisible(card, currentScene, opts) {
  const o = opts || {};
  if (o.includeCrossScene === true) return true;
  if (!currentScene) return true;
  const cs = sceneOfCard(card);
  if (!cs) return true;
  return cs === currentScene;
}

/**
 * 统计：给一条查询结果做隔离前后的对照（排查用）。
 * @returns {{total:number, hidden:number, byScene:object}}
 */
export function summarize(cards, currentScene, opts) {
  const list = Array.isArray(cards) ? cards : [];
  let hidden = 0;
  const byScene = {};
  for (const c of list) {
    const s = sceneOfCard(c) || '(未声明)';
    byScene[s] = (byScene[s] || 0) + 1;
    if (!isVisible(c, currentScene, opts)) hidden++;
  }
  return { total: list.length, hidden, byScene };
}

export default { SCENE_ROOTS, sceneOfCwd, sceneOfCard, isVisible, summarize };
