/**
 * lib/scoring/adoption.js —— 回合后「真采纳」核验补 hits（Step 3）
 * [2026-10-24 by Assistant · 红队防马太死锁的核心]
 *
 * 为什么不能「召回即 +1」：
 *   Top5 里常有 1 张真有用 + 3~4 张陪跑卡。陪跑卡也 +1 ⇒
 *   第二轮它强度变高 ⇒ 更容易进 Top5 ⇒ 又 +1 ⇒ 两周后铜墙铁壁，新卡永无出头。
 *
 * 判据（红队给的）：只有**最终回复里真的用到**了这张卡，才算采纳：
 *   · 回复里出现卡片的实体（entities），或
 *   · 回复与卡片 title + 前 100 字摘要共享 >= 2 个非常见 bigram
 *
 * 纪律：
 *   · 全程异步 + try-catch，绝不影响主对话进程（白队补丁）。
 *   · 只动 hits / lastHitAt 两个字段，append-only 落盘（LWW 读方语义）。
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
// [2026-11-06 · 红队 P0-2] 统一 id→磁盘文件定位（fail-closed）
import { locateCard, toRawId, withCardLock } from '../memory/card-locator.js';

/** 常见 bigram 白名单：这些重合不算「用了」（否则「User」「今天」就能刷分） */
const COMMON = new Set([
  'User', '今天', '这个', '那个', '什么', '怎么', '可以', '我们', '现在', '问题',
  '一下', '已经', '还是', '就是', '然后', '所以', '因为', '如果', '但是', '没有',
  '需要', '应该', '可能', '好的', '收到', '继续', '开始', '完成', '测试', '检查',
]);

const CJK = /[\u4e00-\u9fff]/;

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    if (COMMON.has(g)) continue;
    // ── [2026-11-04 by Assistant · 反例抓到的真 bug] ──
    //   纯数字/符号的二字组（「0.」「.2」「2.」「v0」）不具语义，
    //   但会让「版本号相同」骗过覆盖率：
    //     卡片 probe「圆桌插件v0.2.2装配」被共享 3 个碎片 → cover 0.214 → 误判
    //     实测全库：版本号回复因此多判 9 张
    //   修法：只认**至少含一个汉字**的二字组。
    if (!CJK.test(g)) continue;
    out.add(g);
  }
  return out;
}

function sharedCount(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const g of A) if (B.has(g)) n++;
  return n;
}

// ── [2026-11-04 by Assistant · 判据 v2（User拍板：保留但不算次数 + 收紧判据）] ──
//   User原话：「保留 但是不算次数 并且调整优化判据」
//
//   【为什么要收紧】实测全库 16,941 张，一条最常见的工程回复
//     「User，Assistant已经把配置文件改好了，路径也确认过，版本号是 0.2.6」
//   在旧判据下命中 **5,336 张** —— 因为 entities 里「配置」「路径」到处都是，
//   且 bigram>=2 太容易（任意两句撞两个二字组就算）。
//
//   【新判据（实测降到 8 张，-99.8%）】
//     ① 实体必须 **>=3 字** 且 **不在常见词表** 才认
//        （「配置」「路径」「模型」这类 2 字通用词一律不算，它们不具区分度）
//     ② bigram 改「覆盖率」：共享数>=3 且 覆盖率>=15%
//        cover = 共享二字组 / 卡片自身二字组总数
//        含义：回复必须**实质覆盖**卡片的一部分，不能只是撞词
//
//   【实测对比（同一回复）】
//     旧判据 5,336 张 → 新判据 8 张
//     另一条「查了日志，进程还在跑」2,128 → 3
//
//   【重要：这个判定不再涨 hits】
//     User的分工：hits（次数权重）只由 memory_get 主动读卡来涨；
//     这里判定「被回复用到」⇒ 只更新 lastHitAt（回顶部）+ adoptCount（留痕）。
//     理由：字面判据本质上在猜，猜对了也不该给「次数权重」发免检通行证。
const GENERIC_ENTITIES = new Set([
  '配置', '路径', '模型', '文件', '参数', '目录', '版本', '日志', '进程', '窗口',
  '插件', '任务', '数据', '系统', '功能', '问题', '时间', '内容', '方式', '状态',
  '代码', '接口', '函数', '变量', '缓存', '内存', '显存', '端口', '服务', '流程',
]);

/**
 * 判定一张卡是否被回复真正采纳（v2 判据）。
 * @param {object} card 卡片（entities / title / summary / content）
 * @param {string} reply 最终回复纯文本
 * @returns {{used:boolean, why:string}}
 */
export function isAdopted(card, reply) {
  const text = String(reply || '');
  if (!text.trim()) return { used: false, why: 'empty-reply' };
  const ents = Array.isArray(card && card.entities) ? card.entities : [];
  // ① 实体命中：必须 >=3 字且不是通用词（2 字通用词无区分度，会大面积误判）
  for (const e of ents) {
    const s = String(e || '').trim();
    if (s.length >= 3 && !GENERIC_ENTITIES.has(s) && text.includes(s)) {
      return { used: true, why: 'entity3:' + s.slice(0, 20) };
    }
  }
  // ② bigram 覆盖率：共享 >=3 且覆盖卡片自身 >=15%
  const probe = String(card && card.title || '') + ' ' + String(card && (card.summary || card.content) || '').slice(0, 100);
  const P = bigrams(probe);
  const n = sharedCount(text, probe);
  const cover = P.size ? n / P.size : 0;
  // [2026-11-04 微调] 原阈值 cover>=0.15 会把「n=5, cover=0.150」卡在边界外（浮点）。
  //   实测漏判一例（「圆桌专家选模型」）。放宽到 >0.14 且保底 n>=3，
  //   既接住边界，又不至于把「撞两个词」放进来（那种 cover 通常 <0.05）。
  // [2026-11-04 二次微调] 反例实测：cover=0.14 仍会放进「完全无关」的卡（1 张）。
  //   收到 >=0.15，同时保留 n>=3 让步进；召回侧那个边界 case 恰好 cover=0.15 仍能接住。
  if (n >= 3 && cover >= 0.15) {
    return { used: true, why: 'bigram:' + n + '/cover' + cover.toFixed(2) };
  }
  return { used: false, why: 'no-overlap(n=' + n + ',cover=' + cover.toFixed(2) + ')' };
}

/**
 * [2026-10-24 Round 15] 从文件里取某 id 的最新一行（LWW 语义）。
 * 用于回避「读-改-写」竞态：调用方持有的内存副本可能已过期。
 */
function readLatestLine(file, id) {
  try {
    if (!file || !existsSync(file)) return null;
    const want = toRawId(id);   // [红队 P0-2] canon 比较
    let last = null;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && toRawId(o.id) === want) last = o;
    }
    return last;
  } catch { return null; }
}

/**
 * 批量核验并落盘（append-only 版本行）。
 * @param {{cards:Array, reply:string, file:string, nowTs?:number, maxBump?:number}} p
 * @returns {{bumped:number, details:Array}}
 */
export function commitAdoptions(p) {
  const params = p || {};
  const cards = Array.isArray(params.cards) ? params.cards : [];
  const reply = String(params.reply || '');
  const file = String(params.file || '');
  const nowTs = Number(params.nowTs) || Date.now();
  const maxBump = Number(params.maxBump) || 5;
  const details = [];
  let bumped = 0;
  try {
    // ── [红队 P0-2] 不再要求传入的 file 存在（它多按 createdAt 猜错日期文件，分片/归档必错）。
    //   每张卡走 locateCard 定位**真实**文件（读卡时已附 sourcePath）；读不到就 fail-closed。
    //   分工不变：lastHitAt=回顶部（两来源都写）/ adoptCount=留痕 / 绝不涨 hits。
    if (!reply.trim() || !cards.length) return { bumped: 0, details };
    for (const card of cards.slice(0, maxBump)) {
      try {
        const r = isAdopted(card, reply);
        details.push({ id: card && card.id, used: r.used, why: r.why });
        if (!r.used) continue;
        // [独立复审 R2-1] 以卡 raw id 加跨进程锁：锁内完成 定位→读最新→合并→追加，杜绝并发丢更新
        const res = withCardLock(card && card.id !== undefined ? card.id : 'adopt', () => {
          // 目标文件优先级：① 显式 file（且真含该 id，如调用方/测试指定）→ ② 定位器（sourcePath/分片/归档）
          let diskRaw = null;
          let realFile = null;
          if (file && existsSync(file)) { diskRaw = readLatestLine(file, card.id); if (diskRaw) realFile = file; }
          if (!diskRaw) {
            const loc = locateCard(card);
            if (loc) { diskRaw = loc.row; realFile = loc.file; }
          }
          if (!diskRaw || !realFile) return { ok: false, reason: 'disk-original-not-found' };
          const baseAdopt = Math.max(Number(card.adoptCount) || 0, Number(diskRaw.adoptCount) || 0);
          const adoptPatch = {
            // hits 原样保留（不再 +1）
            lastHitAt: nowTs,
            adoptCount: baseAdopt + 1,
            adoptReason: r.why,
          };
          const next = Object.assign({}, diskRaw, adoptPatch);
          const dir = realFile.replace(/[/\\][^/\\]+$/, '');
          try { if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch {}
          appendFileSync(realFile, JSON.stringify(next) + '\n', 'utf8');
          return { ok: true, file: realFile, adoptCount: baseAdopt + 1 };
        });
        if (res && res.ok) bumped++;
        else details.push({ id: card && card.id, used: true, error: (res && res.reason) || 'write-failed' });
      } catch (e) { details.push({ id: card && card.id, error: String(e && e.message || e) }); }
    }
  } catch (e) {
    // 绝不抛出：采纳核验失败不影响主对话
    return { bumped, details, error: String(e && e.message || e) };
  }
  return { bumped, details };
}
