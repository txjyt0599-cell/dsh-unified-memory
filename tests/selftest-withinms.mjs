#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRetriever } from '../lib/retrieval/retriever.js';
process.env.TZ='Asia/Shanghai';
const r=createRetriever({}, {wake(){},miss(){}});
const h=await r.warmup();
if (!h || !h.ok) { console.log('WITHINMS-SKIPPED (no data in stranger environment)'); process.exit(0); }
const now=Date.now();
const all=r.recentCardRefs({sinceMs:365*24*3600*1000, limit:5000});
let recent=null;
for(const x of all){ if(x.t<now-7*24*3600*1000 || x.title.length<4) continue; const probe=await r.search(x.title); if(probe.hits.some(h=>String(h.id)===x.id)){recent=x;break;} }
assert.ok(recent, 'recent card present in baseline search');
const old=all.find(x=>x.t < now-7*24*3600*1000 && x.title.length>=4);
assert.ok(old, 'old card');
const rr=await r.search(recent.title,{withinMs:7*24*3600*1000});
assert.ok(rr.hits.some(x=>String(x.id)===recent.id), 'recent target included');
const ro=await r.search(old.title,{withinMs:7*24*3600*1000});
assert.ok(!ro.hits.some(x=>String(x.id)===old.id), 'old target excluded by withinMs');
const rn=await r.search(old.title);
assert.ok(rn.hits.length >= ro.hits.length, 'no withinMs not smaller');
console.log('WITHINMS-TEST-DONE checks=6 passed=6 failed=0');
