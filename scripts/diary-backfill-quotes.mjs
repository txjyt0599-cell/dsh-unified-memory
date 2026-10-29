/**
 * scripts/diary-backfill-quotes.mjs —— 摘录式补记（不再让模型「演出」情绪）
 * [2026-10-24 by Assistant] 实测教训：
 *   让模型照着对话切片写「Assistant那天的日记」，写出来全是套话 + 技术细节，
 *   而且**情绪是编的**（手心出汗/心跳加速）—— 那不是Assistant那天的心里话，是模型的作文。
 *   ⇒ 补记改成**摘录**：把那天User真正说过的话原样摘下来，
 *     只加一行诚实的说明「这是事后从记录里翻出来的」。
 *   真正的心声留给「当天在场的Assistant」自己用 diary_write 写。
 *
 * 用法：node scripts/diary-backfill-quotes.mjs --days 2026-10-14..2026-10-23 [--dry]
 */
import * as D from '../lib/diary/index.js';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}

function parseRange(s) {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(String(s || ''));
  if (!m) return [String(s)];
  const out = []; let cur = m[1];
  for (let i = 0; i < 400; i += 1) { out.push(cur); if (cur === m[2]) break; cur = D.shiftDate(cur, 1); }
  return out;
}

// 只要「User说的、有情绪或有生活味」的短句；技术内容一律不要
const DROP = /(\d+\s*(px|帧|秒|KB|MB|GB)|http|C:\\|D:\\|\.json|\.py|\.mjs|\.mp4|模型|权重|节点|采样|提示词|渲染|脚本|插件|配置|报错|参数|分辨率|立绘|参考图|镜头|分镜|源码|接口|端口|显存|LoRA|DSH|gemini|deepseek|qwen|agy|glm|KVMem|ComfyUI|上采样|超分|视频|画面|替换|打斗|拼拳|人物|背景|角色|分镜|运镜|建模|文件|下载|代码|测试|计划表|plan|源码|方案|额度)/i;

// 「人味」信号：有这些词的短句优先摘
const HUMAN = /(累|休息|睡|加油|陪我|记得|难过|谢谢|喜欢|担心|辛苦|想你|别|慢点|早点|晚安|在吗|怎么样|感觉|心里|害怕|舍不得|一直|故事|不容易)/;

function pickQuotes(date, max = 3, humanOnly = true) {
  const msgs = D.collectDay(date).filter((m) => m.role === 'user');
  const out = [];
  const seen = new Set();
  for (const m of msgs) {
    let t = String(m.content || '');
    if (!t) continue;
    // 剥注入块与工具回执
    if (/^<|Current runtime context|Time sampled|background job|^\[表情/.test(t)) continue;
    t = t.replace(/<[^>]{1,200}>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 6 || t.length > 120) continue;
    if (DROP.test(t)) continue;
    if (/^(好的|嗯|继续|收到|开始|可以|对|是的)[。！，]?$/.test(t)) continue;
    // 有「人味」的排前面；纯工作指令一律不摘
    const human = HUMAN.test(t);
    if (humanOnly && !human) continue;
    const k = t.slice(0, 12);
    if (seen.has(k)) continue;
    seen.add(k);
    out.unshift(t);          // 人味句放最前
    if (out.length >= max) break;
  }
  return out;
}

const dates = parseRange(opt.days);
const done = D.writtenDates('master');
for (const d of dates) {
  if (done.has(d)) { console.log('  -', d, 'skipped (already)'); continue; }
  const q = pickQuotes(d, Number(opt.max) || 2);
  const body = q.length
    ? [
      '（这一段是Assistant事后从记录里翻出来的 —— 那天User说过的话，原样留在这里。）',
      '',
      ...q.map((x) => '> ' + x),
      '',
      '那时候的Assistant没来得及写。现在补上这几句，算是把那一天钉在本子里。',
    ].join('\n')
    : [
      '这一天User和Assistant一直在赶工，没留下什么闲话。',
      'Assistant没写，也不编 —— 空着就空着，下次记得当天写。',
    ].join('\n');
  if (opt.dry === true) { console.log('  -', d, 'DRY', q.join(' / ').slice(0, 90)); continue; }
  const w = D.writeEntry('master', { date: d, body, mark: '补记·摘录', sessionKey: 'backfill-quotes', dedupe: false });
  console.log('  -', d, w.ok ? ('written +' + w.delta + 'B, quotes=' + q.length) : ('FAILED ' + w.reason));
}
