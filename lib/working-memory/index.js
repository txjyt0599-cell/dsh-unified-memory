/**
 * index.js —— 期4 分层工作记忆的出口。
 * 只 re-export，不含逻辑；不 import 任何期1/2/3 的写路径。
 */

export {
  WM_LEVELS, RENDER_TIER, WM_REASON, WM_DEFAULTS, WM_HARD, resolveConfig, normalizeActivation,
} from './types.js';

export { computeL0Budget, renderCardLine, finalScore, isIntersection } from './budget.js';

export { createGraphAdapter, createSpreader, MaxHeap } from './spread.js';

export {
  createActivationStore, mergeActivation, mergeActivationFiles, decayedActivation,
  DEFAULT_WM_DIR, ACTIVATION_FILE,
} from './activation-store.js';

export { planEviction } from './evict.js';

export { createWorkingMemory, STATE_PREFIX } from './working-memory.js';

import { createWorkingMemory as _c } from './working-memory.js';
export default { createWorkingMemory: _c };
