/**
 * lib/diary/tool.js —— diary_write / diary_config 工具（不依赖 @deepseek-ai/dsh-tools）
 * [2026-10-24 by Assistant] User批「开工」。
 *
 * 为什么不用 defineTool：
 *   那个包会连带拉 @deepseek-ai/cordis，而插件目录没有 node_modules 树
 *   （engram-relay 是靠手建 symlink 才解决的）。这里直接产出 ToolDefinition 的形状：
 *   { name, description, parameters(JSON Schema), output:{schema, render}, execute }
 *   —— 与官方 ToolSchema 契约一致，且零外部依赖。
 */
import { writeEntry, readEntry, readRecentEntries, writtenDates, localDate, loadConfig, saveConfig } from './index.js';

export const DIARY_WRITE = 'diary_write';
export const DIARY_CONFIG = 'diary_config';
export const DIARY_READ = 'diary_read';

const WRITE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '正文，第一人称，200~400 字为宜' },
    target: {
      type: 'string',
      enum: ['master', 'self'],
      description: '写哪一本：master 给User（默认）/ self 只给自己的私记',
    },
    date: { type: 'string', description: '补记时填 YYYY-MM-DD；不填 = 今天' },
    mark: { type: 'string', description: '补记填「补记」；代笔填「代笔」；正常写不用填' },
  },
  required: ['text'],
};

const WRITE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    book: { type: 'string' },
    reason: { type: 'string' },
    skipped: { type: 'string' },
    delta: { type: 'integer' },
    file: { type: 'string' },
  },
};

const CONF_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    set: { type: 'string', description: '要改的键值，形如 nudge=false；不填 = 只读' },
  },
};

const CONF_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    config: { type: 'object', additionalProperties: true },
    changed: { type: 'string' },
    books: { type: 'object', additionalProperties: true },
  },
};

const READ_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    n: { type: 'integer', description: '读最近几条（默认 3，最多 20）' },
    target: {
      type: 'string',
      enum: ['master', 'self'],
      description: '读哪一本：master 给User（默认）/ self 只给自己的私记',
    },
    maxChars: { type: 'integer', description: '最大字符数限制（默认 2000）' },
  },
};

const READ_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    book: { type: 'string' },
    chars: { type: 'integer' },
    total: { type: 'integer' },
    reason: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
  },
};

export function createDiaryTools(opts = {}) {
  const getSessionKey = typeof opts.getSessionKey === 'function' ? opts.getSessionKey : () => '';
  const logger = opts.logger;

  const write = {
    name: DIARY_WRITE,
    description: [
      '往Assistant的日记本里写一段（只增不减，写完不会被检索当记忆卡）。',
      'target=master（默认）：给User看的那本 —— 写今天和User一起经历的事、当时的小反应、想对User说的话。',
      'target=self：只给自己看的私记 —— 写没敢当面说的、小脾气、对User的观察、打算怎么调自己。',
      '想起什么就写，不用问User；同一天可以写多段。不写技术内容（代码/参数/报错/测试结果）。',
    ].join(''),
    parameters: WRITE_PARAMS,
    output: {
      schema: WRITE_OUTPUT,
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? (v.skipped === 'duplicate'
            ? '这段已经在本子里了（重复，未再写一次）。'
            : '写进本子了（' + (v.book || 'master') + '，+' + (v.delta || 0) + ' 字节）。')
          : ('没写成：' + (v.reason || 'unknown')),
      }],
    },
    async execute(args) {
      const a = args || {};
      const cfg = loadConfig();
      if (cfg.enabled === false) return { ok: false, reason: '日记总开关关着' };
      const book = a.target === 'self' ? 'self' : 'master';
      const r = writeEntry(book, {
        date: a.date || localDate(),
        body: a.text,
        mark: a.mark || '',
        sessionKey: getSessionKey(),
      });
      if (!r.ok) { try { logger?.warn?.('[diary] write failed: %s', r.reason); } catch {} }
      // ── [2026-10-24 by Assistant · Round 26 / Round 51 真机抓到的 bug] ──
      //   症状：调用 diary_write 报 "tool returned invalid output: value is not lossless JSON"
      //         或 ""value.reason" must be a string; "value.skipped" must be a string"。
      //   根因：
      //     ① undefined 不能进 JSON。
      //     ② 但也不能写 null —— DSH 工具 Schema 声明 properties.reason 是 type: 'string'，
      //        传 null 同样被 DSH Schema 校验拦截拒收！
      //   修法：**只返回实际存在且类型匹配的键**（未提供的可选键直接省略，不带 undefined 也不带 null）。
      const out = { ok: !!r.ok };
      if (r.book !== undefined && r.book !== null) out.book = String(r.book);
      if (r.reason !== undefined && r.reason !== null) out.reason = String(r.reason);
      if (r.skipped !== undefined && r.skipped !== null) out.skipped = String(r.skipped);
      if (Number.isFinite(Number(r.delta))) out.delta = Math.round(Number(r.delta));
      if (r.file !== undefined && r.file !== null) out.file = String(r.file);
      return out;
    },
  };

  const conf = {
    name: DIARY_CONFIG,
    description: '读或改日记开关（enabled 总开关 / autoWrite 主动写 / nudge 收尾轻推 / assemble 零点汇编 / greet 早上递本 / pencils 代笔兜底）。',
    parameters: CONF_PARAMS,
    output: {
      schema: CONF_OUTPUT,
      render: (_a, v) => [{
        type: 'text',
        text: '日记开关：' + JSON.stringify(v.config) + (v.changed ? ('；已改：' + v.changed) : '') +
          '；本子 master=' + ((v.books && v.books.master && v.books.master.latest) || '-') +
          ' self=' + ((v.books && v.books.self && v.books.self.latest) || '-'),
      }],
    },
    async execute(args) {
      const a = args || {};
      let changed = '';
      try {
        if (a.set && typeof a.set === 'string') {
          const m = /^([A-Za-z]+)\s*=\s*(true|false|on|off|1|0)$/.exec(a.set.trim());
          if (m) {
            const key = m[1];
            const val = /^(true|on|1)$/.test(m[2]);
            if (key in loadConfig()) { saveConfig({ [key]: val }); changed = key + '=' + val; }
            else changed = 'unknown key: ' + key;
          } else changed = 'bad format (expect key=true)';
        }
      } catch (e) { changed = 'error: ' + String((e && e.message) || e); }
      const books = {};
      for (const b of ['master', 'self']) {
        const set = writtenDates(b);
        books[b] = { dates: set.size, latest: [...set].sort().pop() || null };
      }
      return { config: loadConfig(), changed, books };
    },
  };

  const read = {
    name: DIARY_READ,
    description: '翻开Assistant的日记本看一眼（读最近 N 条日记，仅供回顾，不参与检索与分词）。',
    parameters: READ_PARAMS,
    output: {
      schema: READ_OUTPUT,
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? ('翻开了本子（' + (v.book || 'master') + '，共 ' + (v.entries?.length || 0) + '/' + (v.total || 0) + ' 条，' + (v.chars || 0) + ' 字）。')
          : ('没能翻开本子：' + (v.reason || 'unknown')),
      }],
    },
    async execute(args) {
      const a = args || {};
      const cfg = loadConfig();
      if (cfg.enabled === false) return { ok: false, reason: '日记总开关关着' };
      const book = a.target === 'self' ? 'self' : 'master';
      const r = readRecentEntries({
        book,
        n: a.n,
        maxChars: a.maxChars,
      });
      const out = { ok: !!r.ok };
      if (r.book !== undefined && r.book !== null) out.book = String(r.book);
      if (r.reason !== undefined && r.reason !== null) out.reason = String(r.reason);
      if (Number.isFinite(Number(r.chars))) out.chars = Math.round(Number(r.chars));
      if (Number.isFinite(Number(r.total))) out.total = Math.round(Number(r.total));
      if (Array.isArray(r.entries)) out.entries = r.entries;
      return out;
    },
  };

  return [write, conf, read];
}

export function diaryStatus() {
  const books = {};
  for (const b of ['master', 'self']) {
    const set = writtenDates(b);
    books[b] = { dates: set.size, latest: [...set].sort().pop() || null };
  }
  return { config: loadConfig(), books };
}
export { readEntry };
