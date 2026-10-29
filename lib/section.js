/**
 * 唯一接缝：systemPrompt.section 的 text 回调。
 * 铁律（坑1）：全程 try/catch，任何异常 return ''（否则整轮崩）。
 *
 * [2026-10-21 by Assistant · P0 接线] 本文件原为「期1 骨架」——只报后端健康状态，
 * 从不注入记忆内容（生产日志 chars=130 恒定，就是它的锅）。
 * 现改为：**优先读 prefetch 缓存里的现成注入串**，未命中才回退健康状态段。
 * 为什么读缓存：section 接缝是同步的，而检索是 async —— 见 prefetch.js 头注释。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
// [2026-10-22 期7-D] 接管 persona 注入（关旧 tdai 后画像不丢）
import { readPersona, DEFAULT_PERSONA_SRC } from './ingest/persona.js';
// [2026-10-23 by Assistant · 白队补充2/红队修正3：公理待审池读取（只在冷启动/新会话读一次）]
import { consumeAxioms } from './ingest/axioms.js';
import { dataPath } from './paths.js';

export function createSectionRenderer({ orchestrator, prefetcher = null, config = {}, logger = null } = {}) {
  // [2026-10-22 by Assistant · 注入诊断] 每次渲染都把结果落盘取证。
  //   目的：不依赖「AI 读自己的上下文」这种不可靠手段，直接看 provider 到底返回了什么。
  const PROBE_DIR = dataPath('probe');
  function probe(entry) {
    try {
      mkdirSync(PROBE_DIR, { recursive: true });
      appendFileSync(PROBE_DIR + '/section-render.jsonl', JSON.stringify(entry) + '\n');
    } catch {}
  }
  // ── [2026-10-24 by Assistant · Round 25 删死代码] ──
  //   maxChars 也在这里躺了很久：system 段是**固定文本**，不做截断，所以它从没被用。
  //   原本这里还有 freeze 和 snapshots 两个变量，**全文从未被使用**：
  //   · freeze 只被读了一下（config.freezePerSession !== false），没参与任何决策
  //   · snapshots 声明了 Map，再无一处 get/set ⇒ 纯占位
  //   真正实现「会话级冻结」的是下面 personaSnapshots / axiomSnapshots。
  //   死代码害处：读代码的人会以为"冻结在这里"，从而找不到真实实现。
  // [2026-10-22] persona 的会话级快照 —— 同会话内逐字节稳定，不破前缀缓存
  const personaSnapshots = new Map();
// [2026-10-23] 公理快照：同一会话只读一次待审池，保证 system 逐字节稳定
const axiomSnapshots = new Map();

  const keyOf = (assembly) => {
    const agent = assembly?.agent;
    const sid = agent?.session?.id || agent?.sessionId || agent?.id || 'anon';
    return String(sid);
  };

  /** 期1 健康状态段（缓存未命中时的回退，保证不空窗） */
  function renderHealth() {
    const avail = orchestrator?.levelAvailability?.() || {};
    const lines = [];
    lines.push('<unified-memory>');
    lines.push('（记忆检索尚未就绪：本段只报告后端健康状况）');
    for (const [k, v] of Object.entries(avail)) lines.push('  - ' + k + ': ' + (v ? 'up' : 'down'));
    lines.push('</unified-memory>');
    return lines.join('\n');
  }

  return function renderDigest(assembly) {
    // ════════════════════════════════════════════════════════════════════════
    // [2026-10-22 by Assistant · 前缀缓存修复]
    //   旧实现：这里返回 pre-step 检索到的**动态**记忆串。
    //   后果：systemPrompt.section 每轮内容不同 ⇒ system prompt 前缀每轮失效
    //        ⇒ prefix cache 全废，缓存命中率一路往下掉。
    //   现在：动态记忆改走 agent/pre-step 的**消息尾注入**（见 index.js）；
    //        system 里只保留这段**完全固定**的说明，逐字节不变。
    //   —— 同样的教训 engram-relay 早写过：「固定文本，零动态：system 稳定 → 前缀缓存保持命中」。
    // ════════════════════════════════════════════════════════════════════════
    const FIXED = '<unified-memory>\n'
      + '（长期记忆已启用：每轮检索到的相关往事会注入到**本轮消息末尾**，不在本段。\n'
      + '  本段固定不变——保证 system prompt 逐字节稳定、前缀缓存持续命中。）\n'
      + '<host_axioms>\n'
      // ── [2026-10-23 by Assistant · 白队终裁：宿主机公理焊进静态段] ──
      //   三重独立验证：WMI AdapterRAM=4GB（32位整型溢出误报）/
      //   注册表 qwMemorySize=15.92GB / dxdiag Dedicated=15.81GB
      //   ⇒ RX 9060 XT 真实物理显存 = 16GB。
      + '  宿主机公理（优先级最高，高于任何日志/探针/历史记忆）：\n'
      + '  - 主显卡 AMD Radeon RX 9060 XT，**真实物理显存 16GB**（RDNA4 / gfx1200）。\n'
      + '  - 核显 Radeon 780M 约 2GB，通常不参与计算。\n'
      + '  - [防误报铁律] Windows 32 位 API（WMI AdapterRAM）整型溢出，\n'
      + '    会把 16GB 卡错报成 4GB/4095MB。凡见 "9060XT 4G" 一律视为误报，\n'
      + '    严禁采信，一律按 16GB 认知。\n'
      + '</host_axioms>\n'
      + '</unified-memory>';

    // ═══════════════════════════════════════════════════════════════════════
    // [2026-10-22 by Assistant · 期7-D 关旧前置：接管 persona 注入]
    //
    //   背景：`<user-persona>` 原本由 tdai 的 auto-recall.js 注入。
    //   一旦关掉 tdai，User画像就没人注入了 —— 这是关旧的真实代价。
    //
    //   这里让 unified-memory 自己接管：
    //     · 内容来源：tdai 的 persona.md（只读；缺失则用超图自己的 persona-notes.md）
    //     · **稳定性**：按 sessionId 做快照，同一会话内逐字节不变 ⇒ 不破前缀缓存
    //       （若每轮重读文件，文件一变 system 就变，缓存全废——这是坑。）
    //     · 开关：config.personaInject === true 才注入（默认关，先在旁路观察）
    // ═══════════════════════════════════════════════════════════════════════
    let personaPart = '';
    if (config.personaInject === true) {
      try {
        const key = keyOf(assembly);
        // 会话级快照：同一会话只读一次文件，后续复用（保证逐字节稳定）
        if (!personaSnapshots.has(key)) {
          personaSnapshots.set(key, null);   // 占位，防递归
          const personaSrc = config.personaSrc || DEFAULT_PERSONA_SRC;
          const ownPath = config.personaNotesPath || null;
          const p = readPersona(personaSrc, ownPath);
          if (p && p.text) {
            // 只取前 N 字：persona.md 有 32KB，全塞进 system 太贵且没必要
            const budget = Number(config.personaMaxChars) || 3000;
            const body = p.text.slice(0, budget);
            personaSnapshots.set(key, '<user-persona>\n' + body + '\n</user-persona>');
            logger?.wake?.({ level: 'persona-inject', source: p.source, chars: body.length, degraded: !!p.degraded });
          }
        }
        personaPart = personaSnapshots.get(key) || '';
      } catch (e) {
        try { logger?.miss?.({ level: 'persona-inject-failed', reason: String(e && e.message || e) }); } catch {}
      }
    }

    // ── [2026-10-23 by Assistant · 公理合入（红队修正3 + 白队补充2）] ──
    //   铁律：**只在会话首次渲染时读一次待审池并快照**，
    //   同一会话内逐字节不变 ⇒ 前缀缓存不受影响。
    //   绝不在对话进行中重读文件（那会让 system 每轮变，缓存全废）。
    let axiomPart = '';
    if (config.axiomStagingEnabled === true) {
      try {
        const k = keyOf(assembly);
        if (!axiomSnapshots.has(k)) {
          const c = consumeAxioms(config.axiomsPendingPath || null);
          const list = (c && c.axioms) || [];
          axiomSnapshots.set(k, list.length
            ? '<established_axioms>\n' + list.map(function (a) {
                return '- ' + String(a.title || '').slice(0, 40) + '：' + String(a.text || '').slice(0, 200);
              }).join('\n') + '\n</established_axioms>\n'
            : '');
        }
        axiomPart = axiomSnapshots.get(k) || '';
      } catch (e) { axiomPart = ''; }
    }
    const OUT = (personaPart ? (personaPart + '\n' + FIXED) : FIXED) + axiomPart;
    try {
      probe({ at: new Date().toISOString(), source: 'fixed-section', key: keyOf(assembly), chars: OUT.length, persona: personaPart.length });
      logger?.wake({ level: 'section-render', chars: OUT.length, source: 'fixed', personaChars: personaPart.length });
    } catch {}

    return OUT;
  };
}
