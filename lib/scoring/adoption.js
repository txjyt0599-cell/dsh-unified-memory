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
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

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

/**
 * 判定一张卡是否被回复真正采纳。
 * @param {object} card 卡片（entities / title / summary / content）
 * @param {string} reply 最终回复纯文本
 * @returns {{used:boolean, why:string}}
 */
export function isAdopted(card, reply) {
  const text = String(reply || '');
  if (!text.trim()) return { used: false, why: 'empty-reply' };
  const ents = Array.isArray(card && card.entities) ? card.entities : [];
  // ① 实体命中：只认长度 >= 2 的实体（避免「A」「C」这类噪音）
  for (const e of ents) {
    const s = String(e || '').trim();
    if (s.length >= 2 && text.includes(s)) return { used: true, why: 'entity:' + s.slice(0, 20) };
  }
  // ② bigram 共现：只看 title + 前 100 字摘要（压 CPU）
  const probe = String(card && card.title || '') + ' ' + String(card && (card.summary || card.content) || '').slice(0, 100);
  const n = sharedCount(text, probe);
  if (n >= 2) return { used: true, why: 'bigram:' + n };
  return { used: false, why: 'no-overlap' };
}

/**
 * [2026-10-24 Round 15] 从文件里取某 id 的最新一行（LWW 语义）。
 * 用于回避「读-改-写」竞态：调用方持有的内存副本可能已过期。
 */
function readLatestLine(file, id) {
  try {
    if (!file || !existsSync(file)) return null;
    const want = String(id);
    let last = null;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && String(o.id) === want) last = o;
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
    if (!reply.trim() || !cards.length || !file || !existsSync(file)) return { bumped: 0, details };
    const lines = [];
    for (const card of cards.slice(0, maxBump)) {
      try {
        const r = isAdopted(card, reply);
        details.push({ id: card && card.id, used: r.used, why: r.why });
        if (!r.used) continue;
        // ── [2026-10-24 by Assistant · Round 15 抓到的竞态] ──
        //   原来直接用调用方传进来的 card.hits +1。
        //   但调用方持有的是**上一次读盘的内存副本** ⇒ 连续两轮采纳时：
        //     第 1 轮：0 → 1（写盘）
        //     第 2 轮：内存里还是 0 ⇒ 又写 1（覆盖）⇒ hits 永远停在 1
        //   这是 RMW 竞态：必须**写前先读盘拿最新 hits**（LWW 语义下同 id 取最后一行）。
        //   注：不加文件锁也能接受 —— 采纳是异步单线程回调，且 LWW 只要求"不倒退"。
        let baseHits = Number(card.hits) || 0;
        try {
          const rawNow = readLatestLine(file, card.id);
          if (rawNow && Number.isFinite(Number(rawNow.hits))) baseHits = Math.max(baseHits, Number(rawNow.hits));
        } catch {}
        const next = Object.assign({}, card, {
          hits: baseHits + 1,
          lastHitAt: nowTs,
          hitReason: r.why,
        });
        lines.push(JSON.stringify(next));
        bumped++;
      } catch (e) { details.push({ id: card && card.id, error: String(e && e.message || e) }); }
    }
    if (lines.length) appendFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch (e) {
    // 绝不抛出：采纳核验失败不影响主对话
    return { bumped, details, error: String(e && e.message || e) };
  }
  return { bumped, details };
}
