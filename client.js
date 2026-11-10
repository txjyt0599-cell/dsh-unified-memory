/* dsh-unified-memory — Memory OS dashboard. No credentials are handled in this bundle. */
window.__ModuleLoader__.load({
  id: 'dsh-unified-memory',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const API = '/api/unified-memory';
    let styleMounted = false;

    const css = `
.pm-root{--pm-blue:#5b7cfa;--pm-cyan:#32c7d9;--pm-green:#20a779;--pm-red:#df5c68;--pm-amber:#bd7b21;color:var(--dsw-alias-color-text-primary);font-size:13px;line-height:1.5;height:100%;min-height:100%;max-height:100vh;overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box}
.pm-root *{box-sizing:border-box}
.pm-shell{display:grid;grid-template-columns:196px minmax(0,1fr);height:auto;min-height:720px;background:var(--dsw-alias-color-bg-primary);border:1px solid var(--dsw-alias-color-border-primary);border-radius:14px;overflow:hidden}
.pm-shell.pm-embedded{min-height:0}
.pm-shell.pm-embedded{height:auto;max-height:none}
.pm-root:has(.pm-shell.pm-embedded){max-height:none;overflow:visible}
.pm-shell.pm-embedded .pm-main{overflow:visible}
.pm-side{position:sticky;top:0;align-self:start;max-height:100vh;overflow-y:auto;padding:24px 14px;background:color-mix(in srgb,var(--dsw-alias-color-bg-secondary) 80%,transparent);border-right:1px solid var(--dsw-alias-color-border-primary);display:flex;flex-direction:column}
.pm-brand{display:flex;align-items:center;gap:10px;padding:0 10px 24px}
.pm-brand-mark{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:white;background:linear-gradient(145deg,#718cff,#4657bd);box-shadow:0 7px 20px #5268c52b}
.pm-brand-name{font-size:13px;font-weight:700;letter-spacing:.08em}
.pm-brand-sub{font-size:10px;color:var(--dsw-alias-color-text-tertiary);letter-spacing:.12em;margin-top:1px}
.pm-nav-label{font-size:10px;color:var(--dsw-alias-color-text-tertiary);letter-spacing:.14em;padding:8px 12px}
.pm-nav{width:100%;border:0;background:transparent;color:var(--dsw-alias-color-text-secondary);display:flex;align-items:center;gap:10px;padding:10px 12px;margin:2px 0;border-radius:8px;cursor:pointer;text-align:left;font-size:12px;transition:background .16s,color .16s}
.pm-nav:hover{background:var(--dsw-alias-color-bg-hover);color:var(--dsw-alias-color-text-primary)}
.pm-nav.active{color:#5269d9;background:color-mix(in srgb,#627ae6 12%,transparent);font-weight:600}
.pm-nav.active svg{color:#5269d9}
.pm-side-bottom{margin-top:auto;padding:16px 10px 4px;border-top:1px solid var(--dsw-alias-color-border-primary)}
.pm-local{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-color-text-secondary)}
.pm-dot{width:6px;height:6px;border-radius:50%;background:var(--pm-green);box-shadow:0 0 0 3px color-mix(in srgb,var(--pm-green) 13%,transparent)}
.pm-version{font-size:10px;color:var(--dsw-alias-color-text-tertiary);margin-top:8px}
.pm-main{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;background:var(--dsw-alias-color-bg-primary)}
.pm-topbar{position:sticky;top:0;z-index:6;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 30px;border-bottom:1px solid var(--dsw-alias-color-border-primary);background:var(--dsw-alias-color-bg-primary)}
.pm-crumb{color:var(--dsw-alias-color-text-tertiary);font-size:11px;letter-spacing:.04em}
.pm-top-actions{display:flex;align-items:center;gap:10px}
.pm-content{padding:26px 30px 34px;max-width:1420px}
.pm-hero{position:relative;overflow:hidden;min-height:218px;border-radius:16px;padding:32px 36px;color:#f5f7ff;background:radial-gradient(circle at 78% 40%,#6776e32e,transparent 33%),linear-gradient(118deg,#111a36,#1a2550 58%,#162b4a);display:flex;align-items:center;justify-content:space-between;isolation:isolate}
.pm-hero:before{content:'';position:absolute;inset:0;opacity:.14;background-image:linear-gradient(#9bacff22 1px,transparent 1px),linear-gradient(90deg,#9bacff22 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(90deg,transparent,#000);z-index:-1}
.pm-eyebrow{font-size:10px;letter-spacing:.22em;color:#91a7e8;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.pm-title{font-size:30px;line-height:1.2;letter-spacing:.02em;margin:0 0 12px;font-weight:650}
.pm-desc{font-size:12px;color:#aeb9d8;max-width:490px;line-height:1.8;margin:0}
.pm-hero-tags{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}
.pm-hero-tag{font-size:10px;padding:4px 9px;border:1px solid #8fa6f12b;border-radius:99px;color:#b9c8f5;background:#a4b6ff09}
.pm-orbit{width:210px;height:170px;position:relative;flex:none;margin-right:18px}
.pm-orbit svg{width:100%;height:100%;overflow:visible}
.pm-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:18px 0 24px}
.pm-stat{padding:18px 20px;border:1px solid var(--dsw-alias-color-border-primary);border-radius:12px;background:var(--dsw-alias-color-bg-secondary);position:relative;overflow:hidden}
.pm-stat-label{font-size:11px;color:var(--dsw-alias-color-text-tertiary);display:flex;align-items:center;justify-content:space-between}
.pm-stat-value{font-size:25px;line-height:1.25;font-weight:650;letter-spacing:-.02em;margin:9px 0 4px;font-variant-numeric:tabular-nums}
.pm-stat-note{font-size:10px;color:var(--dsw-alias-color-text-tertiary)}
.pm-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);gap:18px}
.pm-stack{display:flex;flex-direction:column;gap:18px}
.pm-card{border:1px solid var(--dsw-alias-color-border-primary);border-radius:12px;background:var(--dsw-alias-color-bg-secondary);overflow:hidden}
.pm-card-pad{padding:22px}
.pm-card-head{padding:18px 22px;border-bottom:1px solid var(--dsw-alias-color-border-primary);display:flex;align-items:center;justify-content:space-between;gap:12px}
.pm-card-title{font-size:13px;font-weight:650;display:flex;align-items:center;gap:8px}
.pm-card-subtitle{font-size:10px;color:var(--dsw-alias-color-text-tertiary);margin-top:3px}
.pm-section-head{display:flex;align-items:flex-end;justify-content:space-between;margin:4px 0 18px}
.pm-section-title{font-size:21px;font-weight:650;margin:0;letter-spacing:-.01em}
.pm-section-desc{font-size:11px;color:var(--dsw-alias-color-text-tertiary);margin-top:5px}
.pm-row{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:62px;padding:12px 22px;border-bottom:1px solid var(--dsw-alias-color-border-primary)}
.pm-row:last-child{border-bottom:0}
.pm-row-main{min-width:0}
.pm-row-title{font-size:12px;font-weight:550;display:flex;align-items:center;gap:8px}
.pm-row-desc{font-size:10px;color:var(--dsw-alias-color-text-tertiary);margin-top:3px;line-height:1.55}
.pm-toggle{width:34px;height:20px;flex:none;border:0;border-radius:20px;padding:2px;background:var(--dsw-alias-color-bg-active);cursor:pointer;transition:background .18s;position:relative}
.pm-toggle:after{content:'';display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 4px #0003;transform:translateX(0);transition:transform .18s}
.pm-toggle.on{background:#6279df}
.pm-toggle.on:after{transform:translateX(14px)}
.pm-toggle:disabled{opacity:.45;cursor:wait}
.pm-btn{height:31px;padding:0 12px;border:1px solid var(--dsw-alias-color-border-primary);border-radius:7px;background:var(--dsw-alias-color-bg-secondary);color:var(--dsw-alias-color-text-secondary);display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:11px;cursor:pointer;white-space:nowrap}
.pm-btn:hover{color:var(--dsw-alias-color-text-primary);border-color:var(--dsw-alias-color-border-secondary);background:var(--dsw-alias-color-bg-hover)}
.pm-btn.primary{background:#596fda;border-color:#596fda;color:#fff}
.pm-btn.primary:hover{background:#4b61ca;color:#fff}
.pm-btn:disabled{opacity:.45;cursor:not-allowed}
.pm-icon-btn{width:31px;padding:0}
.pm-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:5px;font-size:9px;line-height:1.5;background:var(--dsw-alias-color-bg-active);color:var(--dsw-alias-color-text-secondary);white-space:nowrap}
.pm-badge.good{color:var(--pm-green);background:color-mix(in srgb,var(--pm-green) 10%,transparent)}
.pm-badge.warn{color:var(--pm-amber);background:color-mix(in srgb,var(--pm-amber) 11%,transparent)}
.pm-badge.bad{color:var(--pm-red);background:color-mix(in srgb,var(--pm-red) 10%,transparent)}
.pm-badge.blue{color:#5872d5;background:#627ae612}
.pm-flow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));position:relative;padding:24px 22px 18px;gap:14px}
.pm-node{padding:16px;border:1px solid var(--dsw-alias-color-border-primary);border-radius:10px;background:var(--dsw-alias-color-bg-primary);position:relative}
.pm-node-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.pm-node-icon{width:29px;height:29px;border-radius:8px;background:#657be813;color:#5c73d7;display:grid;place-items:center}
.pm-node-name{font-size:12px;font-weight:600}
.pm-node-desc{font-size:10px;color:var(--dsw-alias-color-text-tertiary);margin-top:3px}
.pm-node-code{font-size:9px;letter-spacing:.12em;color:#7386d7;margin-top:12px}
.pm-flow-note{padding:0 22px 18px;font-size:10px;color:var(--dsw-alias-color-text-tertiary)}
.pm-index{padding:22px}
.pm-index-model{font-family:var(--dsw-alias-font-family-mono,monospace);font-size:12px;font-weight:600;word-break:break-all}
.pm-index-meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}
.pm-meta-label{font-size:9px;color:var(--dsw-alias-color-text-tertiary);letter-spacing:.08em}
.pm-meta-value{font-size:13px;font-weight:600;margin-top:3px;font-variant-numeric:tabular-nums}
.pm-meter{height:5px;border-radius:5px;background:var(--dsw-alias-color-bg-active);overflow:hidden;margin:9px 0 7px}
.pm-meter>i{height:100%;display:block;background:linear-gradient(90deg,#617be1,#42b8c9);border-radius:5px}
.pm-meter-note{display:flex;justify-content:space-between;color:var(--dsw-alias-color-text-tertiary);font-size:9px}
.pm-notice{margin:0 22px 20px;padding:11px 12px;border-radius:8px;background:#bc81220c;color:var(--dsw-alias-color-text-secondary);font-size:10px;border:1px solid #bc81221c}
.pm-endpoints{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.pm-endpoint{padding:20px;border:1px solid var(--dsw-alias-color-border-primary);border-radius:12px;background:var(--dsw-alias-color-bg-secondary)}
.pm-endpoint-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.pm-endpoint-id{font-family:var(--dsw-alias-font-family-mono,monospace);font-size:10px;color:#6378d5;background:#6178df12;padding:5px 7px;border-radius:6px}
.pm-endpoint-name{font-size:14px;font-weight:650;margin-top:10px}
.pm-endpoint-purpose{font-size:10px;color:var(--dsw-alias-color-text-tertiary);margin-top:3px}
.pm-endpoint-host{font-family:var(--dsw-alias-font-family-mono,monospace);font-size:11px;margin:18px 0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-endpoint-model{font-size:11px;color:var(--dsw-alias-color-text-secondary);word-break:break-all}
.pm-endpoint-info{display:flex;flex-wrap:wrap;gap:6px 14px;margin:16px 0;color:var(--dsw-alias-color-text-tertiary);font-size:9px}
.pm-endpoint-info>span{white-space:nowrap;flex:none}
.pm-endpoint-foot{border-top:1px solid var(--dsw-alias-color-border-primary);padding-top:14px;display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.pm-endpoint-foot>div:first-child{min-width:0}
.pm-endpoint-actions{display:flex;gap:7px;flex:none;margin-left:auto}
.pm-endpoint-actions .pm-btn{height:28px;padding:0 10px;font-size:10px;flex:none}
.pm-test-result{font-size:10px;color:var(--dsw-alias-color-text-tertiary);overflow-wrap:anywhere}
.pm-test-result.good{color:var(--pm-green)}
.pm-test-result.bad{color:var(--pm-red)}
.pm-controls-section{margin-bottom:22px}
.pm-controls-title{font-size:11px;letter-spacing:.08em;color:var(--dsw-alias-color-text-tertiary);margin:0 0 9px 3px;text-transform:uppercase}
.pm-sliders{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px;padding:8px 22px}
.pm-slider{padding:13px 0 16px;border-bottom:1px solid var(--dsw-alias-color-border-primary)}
.pm-slider-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.pm-slider-label{font-size:11px}
.pm-slider-value{font-family:var(--dsw-alias-font-family-mono,monospace);font-size:11px;color:#5b72d2;background:#6178df0d;padding:2px 7px;border-radius:5px}
.pm-slider input{width:100%;height:4px;margin:15px 0 5px;accent-color:#6179db;cursor:pointer}
.pm-slider-range{display:flex;justify-content:space-between;font-size:9px;color:var(--dsw-alias-color-text-tertiary)}
.pm-savebar{position:sticky;bottom:14px;z-index:3;margin:18px auto 0;max-width:560px;padding:10px 12px 10px 16px;border:1px solid #7184df40;border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-color-bg-primary) 92%,transparent);box-shadow:0 10px 30px #11182718;display:flex;align-items:center;justify-content:space-between;gap:14px}
.pm-savebar-text{font-size:11px;color:var(--dsw-alias-color-text-secondary)}
.pm-select{height:30px;border:1px solid var(--dsw-alias-color-border-primary);border-radius:7px;background:var(--dsw-alias-color-bg-primary);color:var(--dsw-alias-color-text-primary);padding:0 28px 0 10px;font-size:11px}
.pm-retrieval{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:18px 22px}
.pm-retrieval-item{background:var(--dsw-alias-color-bg-primary);border-radius:8px;padding:12px}
.pm-retrieval-value{font-size:17px;font-weight:650;margin-top:5px}
.pm-telemetry-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px}
.pm-telemetry-card{padding:16px 18px;border:1px solid var(--dsw-alias-color-border-primary);border-radius:10px;background:var(--dsw-alias-color-bg-secondary)}
.pm-telemetry-name{font-size:10px;color:var(--dsw-alias-color-text-secondary);font-family:var(--dsw-alias-font-family-mono,monospace)}
.pm-telemetry-num{font-size:21px;font-weight:650;margin:8px 0 2px}
.pm-telemetry-meta{font-size:9px;color:var(--dsw-alias-color-text-tertiary)}
.pm-table{width:100%;border-collapse:collapse;font-size:10px}
.pm-table th{text-align:left;color:var(--dsw-alias-color-text-tertiary);font-weight:500;padding:11px 18px;border-bottom:1px solid var(--dsw-alias-color-border-primary)}
.pm-table td{padding:11px 18px;border-bottom:1px solid var(--dsw-alias-color-border-primary);font-variant-numeric:tabular-nums}
.pm-table tr:last-child td{border-bottom:0}
.pm-mono{font-family:var(--dsw-alias-font-family-mono,monospace)}
.pm-empty{padding:48px 24px;text-align:center;color:var(--dsw-alias-color-text-tertiary);font-size:11px}
.pm-loading{min-height:560px;display:grid;place-items:center;color:var(--dsw-alias-color-text-tertiary);font-size:11px}
.pm-toast{position:fixed;right:28px;bottom:26px;z-index:1000;padding:11px 16px;border-radius:9px;background:#19233d;color:#eef2ff;box-shadow:0 10px 30px #0b122540;font-size:11px;animation:pm-in .18s ease-out}
.pm-toast.bad{background:#71343c}
.pm-footer{margin-top:22px;padding-top:14px;border-top:1px solid var(--dsw-alias-color-border-primary);display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-color-text-tertiary);font-size:9px}
.pm-modal-mask{position:fixed;inset:0;z-index:900;background:#0b102080;display:grid;place-items:center;padding:20px}
.pm-modal{width:min(520px,100%);max-height:90vh;overflow:auto;border:1px solid var(--dsw-alias-color-border-secondary);border-radius:14px;background:var(--dsw-alias-color-bg-primary);box-shadow:0 24px 80px #05081655}
.pm-modal-head{padding:20px 22px 16px;border-bottom:1px solid var(--dsw-alias-color-border-primary);display:flex;align-items:center;justify-content:space-between}
.pm-modal-title{font-size:16px;font-weight:650;margin-top:4px}
.pm-modal-body{padding:20px 22px}
.pm-form-field{margin-bottom:16px}
.pm-form-label{display:block;font-size:11px;font-weight:550;margin-bottom:6px}
.pm-form-help{font-size:9px;color:var(--dsw-alias-color-text-tertiary);margin-top:5px}
.pm-input{width:100%;height:36px;padding:0 11px;border:1px solid var(--dsw-alias-color-border-primary);border-radius:7px;background:var(--dsw-alias-color-bg-secondary);color:var(--dsw-alias-color-text-primary);font-size:12px;outline:none}
.pm-input:focus{border-color:#6379dc;box-shadow:0 0 0 3px #6379dc14}
.pm-form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.pm-modal-foot{padding:15px 22px;border-top:1px solid var(--dsw-alias-color-border-primary);display:flex;align-items:center;justify-content:space-between;gap:12px}
.pm-modal-actions{display:flex;gap:8px}
.pm-embedded{min-height:600px}
@keyframes pm-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"],[data-pm-w="lg"]) .pm-shell:not(.pm-embedded){grid-template-columns:64px minmax(0,1fr)}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"],[data-pm-w="lg"]) :is(.pm-brand-name,.pm-brand-sub,.pm-nav-label,.pm-nav span,.pm-side-bottom){display:none}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"],[data-pm-w="lg"]) .pm-brand{padding:0 0 20px;justify-content:center}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"],[data-pm-w="lg"]) .pm-nav{justify-content:center;padding:11px}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"]) :is(.pm-grid,.pm-endpoints){grid-template-columns:1fr}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"]) .pm-retrieval{grid-template-columns:repeat(2,minmax(0,1fr))}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"]) .pm-orbit{display:none}
.pm-root:is([data-pm-w="xs"],[data-pm-w="sm"],[data-pm-w="md"]) .pm-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
.pm-root[data-pm-w="xs"] .pm-content{padding:18px 14px}
.pm-root[data-pm-w="xs"] :is(.pm-flow,.pm-sliders,.pm-telemetry-grid){grid-template-columns:1fr}
.pm-root[data-pm-w="xs"] .pm-topbar{padding:0 14px;min-height:58px;height:auto;gap:8px}
.pm-root[data-pm-w="xs"] .pm-crumb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-root[data-pm-w="xs"] .pm-top-actions{gap:6px;flex:none}
.pm-root[data-pm-w="xs"] .pm-form-row{grid-template-columns:1fr}
.pm-root[data-pm-w="xs"] .pm-footer{flex-direction:column}
.pm-root[data-pm-w="xs"] .pm-title{font-size:25px}
.pm-root[data-pm-w="xs"] .pm-hero{padding:26px 22px}
.pm-root[data-pm-w="xs"] .pm-section-head{flex-direction:column;align-items:flex-start;gap:8px}
.pm-root[data-pm-w="xs"] .pm-card-head{padding:14px 16px}
.pm-root[data-pm-w="xs"] .pm-row{padding:12px 16px}
.pm-root[data-pm-w="xs"] .pm-sliders{padding:8px 16px}
.pm-root[data-pm-w="xs"] .pm-endpoint{padding:16px}
`;

    function mountStyle() {
      if (styleMounted || document.querySelector('style[data-pm-dashboard]')) return;
      const style = document.createElement('style');
      style.setAttribute('data-pm-dashboard', '1');
      style.textContent = css;
      document.head.appendChild(style);
      styleMounted = true;
    }

    async function asJson(res) {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      return body;
    }
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }));
    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }));

    function Icon({ name, size = 16, strokeWidth = 1.7 }) {
      const paths = {
        grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
        route: 'M6 3v12a4 4 0 0 0 4 4h8M18 3v5a4 4 0 0 1-4 4H6M3 3h6M15 3h6',
        sliders: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
        pulse: 'M3 12h4l2-7 4 14 2-7h6',
        memory: 'M9 3H5a2 2 0 0 0-2 2v4a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h4M15 3h4a2 2 0 0 1 2 2v4a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-4M9 8h6M9 16h6M12 8v8',
        refresh: 'M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5',
        cpu: 'M9 9h6v6H9zM5 5h14v14H5zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4',
        layers: 'm12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
        clock: 'M12 8v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
        shield: 'M12 3 4 6v5c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-3zM9 12l2 2 4-4',
        arrow: 'M5 12h14M14 7l5 5-5 5',
      };
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[name] || paths.memory }));
    }

    function Badge({ tone, children }) { return h('span', { className: 'pm-badge ' + (tone || '') }, children); }
    function Toggle({ value, onChange, disabled, label }) {
      return h('button', { type: 'button', className: 'pm-toggle ' + (value ? 'on' : ''), role: 'switch', 'aria-checked': !!value, 'aria-label': label, disabled, onClick: () => onChange(!value) });
    }
    function Button({ children, className = '', ...props }) { return h('button', { type: 'button', className: 'pm-btn ' + className, ...props }, children); }
    function Card({ title, subtitle, action, children, className = '' }) {
      return h('section', { className: 'pm-card ' + className },
        title && h('div', { className: 'pm-card-head' }, h('div', null, h('div', { className: 'pm-card-title' }, title), subtitle && h('div', { className: 'pm-card-subtitle' }, subtitle)), action),
        children);
    }
    function SettingRow({ title, desc, badge, children }) {
      return h('div', { className: 'pm-row' }, h('div', { className: 'pm-row-main' }, h('div', { className: 'pm-row-title' }, title, badge), h('div', { className: 'pm-row-desc' }, desc)), children);
    }
    function PageHead({ title, desc, action }) {
      return h('div', { className: 'pm-section-head' }, h('div', null, h('h2', { className: 'pm-section-title' }, title), h('div', { className: 'pm-section-desc' }, desc)), action);
    }
    const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
    const dateFmt = (value) => {
      if (!value) return '暂无记录';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '暂无记录' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    const navItems = [
      ['overview', 'grid', '运行总览'], ['pipeline', 'sliders', '记忆管线'], ['models', 'cpu', '模型线路'], ['telemetry', 'pulse', '运行遥测'],
    ];
    const levelNames = { retrieval: '检索', 'hot-buffer': '热缓冲', 'cross-session-pulse': '跨会话脉冲', 'l0-tier-open': 'L0 档位展开', 'l0-tier-snapshot': 'L0 快照', 'decay-shadow': '衰减阴影' };

    function Orbit() {
      const dots = [[45,36],[74,24],[106,31],[137,20],[163,43],[34,70],[67,67],[99,56],[132,69],[176,79],[46,103],[80,97],[112,105],[147,99],[65,133],[99,137],[132,132]];
      return h('div', { className: 'pm-orbit', 'aria-hidden': true }, h('svg', { viewBox: '0 0 210 170' },
        h('defs', null, h('linearGradient', { id: 'pm-orb', x1: '0', y1: '0', x2: '1', y2: '1' }, h('stop', { offset: '0', stopColor: '#91a8ff' }), h('stop', { offset: '1', stopColor: '#48d2d4' }))),
        h('ellipse', { cx: 105, cy: 83, rx: 87, ry: 49, fill: 'none', stroke: '#91a8ff', strokeOpacity: .22, transform: 'rotate(-18 105 83)' }),
        h('ellipse', { cx: 105, cy: 83, rx: 68, ry: 72, fill: 'none', stroke: '#7b91ee', strokeOpacity: .18, transform: 'rotate(42 105 83)' }),
        dots.slice(0, 12).map((p, i) => h('line', { key: 'l' + i, x1: 105, y1: 84, x2: p[0], y2: p[1], stroke: '#8da2f0', strokeOpacity: .18 })),
        h('circle', { cx: 105, cy: 84, r: 30, fill: '#8398f412', stroke: 'url(#pm-orb)', strokeOpacity: .7 }),
        h('circle', { cx: 105, cy: 84, r: 18, fill: '#8398f420', stroke: '#a4b7ff', strokeOpacity: .6 }),
        h('path', { d: 'M98 72h-5v9l4 4v10l5 4 5-4V85l4-4v-9h-5M98 81h14M102 77v15', fill: 'none', stroke: '#d8e0ff', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        dots.map((p, i) => h('circle', { key: 'p' + i, cx: p[0], cy: p[1], r: i % 4 === 0 ? 2.3 : 1.4, fill: i % 3 === 0 ? '#65d5d9' : '#9cafff', opacity: .55 + (i % 3) * .15 }))
      ));
    }

    function Overview({ status, updateSetting, saving, setTab }) {
      const s = status.settings;
      const active = ['capture', 'extract', 'distill'].filter((k) => s[k]).length;
      const configured = status.endpoints.filter((e) => e.configured).length;
      const nodes = [
        ['capture', 'layers', '信号捕获', '从对话流筛选有效片段', 'L0 / SIGNAL'],
        ['extract', 'memory', '语义抽取', '模型炼成结构化记忆卡', 'L1 / EXTRACT'],
        ['distill', 'cpu', '记忆蒸馏', '跨卡聚合，沉淀长期记忆', 'L2 / DISTILL'],
      ];
      return h(React.Fragment, null,
        h('section', { className: 'pm-hero' }, h('div', null,
          h('div', { className: 'pm-eyebrow' }, h('span', { className: 'pm-dot' }), 'UNIFIED MEMORY · MEMORY OPERATING SYSTEM'),
          h('h1', { className: 'pm-title' }, '让每一次相遇，都有迹可循。'),
          h('p', { className: 'pm-desc' }, '统一管理记忆捕获、语义炼成、向量索引与检索回路。所有模型遵循 OpenAI 兼容协议，本地优先，故障自动降级。'),
          h('div', { className: 'pm-hero-tags' }, h('span', { className: 'pm-hero-tag' }, 'LOCAL FIRST'), h('span', { className: 'pm-hero-tag' }, 'OPENAI /v1'), h('span', { className: 'pm-hero-tag' }, 'FAIL-SAFE'))
        ), h(Orbit)),
        h('div', { className: 'pm-stats' },
          h('div', { className: 'pm-stat' }, h('div', { className: 'pm-stat-label' }, '向量记忆卡', h(Icon, { name: 'layers', size: 14 })), h('div', { className: 'pm-stat-value' }, fmt(status.index.count)), h('div', { className: 'pm-stat-note' }, status.index.available ? '索引已建立' : '等待建立索引')),
          h('div', { className: 'pm-stat' }, h('div', { className: 'pm-stat-label' }, '向量维度', h(Icon, { name: 'grid', size: 14 })), h('div', { className: 'pm-stat-value' }, status.index.dim || '—'), h('div', { className: 'pm-stat-note' }, status.index.compatible ? '与主路模型兼容' : '需检查模型兼容性')),
          h('div', { className: 'pm-stat' }, h('div', { className: 'pm-stat-label' }, '活跃管线', h(Icon, { name: 'route', size: 14 })), h('div', { className: 'pm-stat-value' }, active + ' / 3'), h('div', { className: 'pm-stat-note' }, s.enabled ? '记忆系统运行中' : '记忆系统已停用')),
          h('div', { className: 'pm-stat' }, h('div', { className: 'pm-stat-label' }, '模型线路', h(Icon, { name: 'cpu', size: 14 })), h('div', { className: 'pm-stat-value' }, configured + ' / 4'), h('div', { className: 'pm-stat-note' }, '配置完整 · 待连通性测试'))
        ),
        h('div', { className: 'pm-grid' },
          h('div', { className: 'pm-stack' },
            h(Card, { title: '记忆炼成管线', subtitle: '从原始对话到长期记忆的三段式处理', action: h(Badge, { tone: s.enabled ? 'good' : 'warn' }, s.enabled ? '运行中' : '已停用') },
              h('div', { className: 'pm-flow' }, nodes.map(([key, icon, name, desc, code]) => h('div', { className: 'pm-node', key },
                h('div', { className: 'pm-node-top' }, h('span', { className: 'pm-node-icon' }, h(Icon, { name: icon })), h(Toggle, { label: name, value: !!s[key], disabled: saving === key, onChange: (v) => updateSetting(key, v) })),
                h('div', { className: 'pm-node-name' }, name), h('div', { className: 'pm-node-desc' }, desc), h('div', { className: 'pm-node-code' }, code)
              ))),
              h('div', { className: 'pm-flow-note' }, '任一级模型故障都会安全降级，不阻塞当前对话。开关修改即时写入热配置。')),
            h(Card, { title: '记忆动力学', subtitle: '决定记忆如何聚合、强化与时间回溯', action: h(Button, { onClick: () => setTab('pipeline') }, '全部参数', h(Icon, { name: 'arrow', size: 13 })) },
              h(SettingRow, { title: '四力模型', desc: '聚合 / 强化 / 衰减 / 关联', badge: h(Badge, null, 'Dynamics') }, h(Toggle, { label: '四力模型', value: !!s.fourForcesEnabled, disabled: saving === 'fourForcesEnabled', onChange: (v) => updateSetting('fourForcesEnabled', v) })),
              h(SettingRow, { title: '语义闪回', desc: '检索到旧记忆时保留其时间语境' }, h(Toggle, { label: '语义闪回', value: !!s.flashbackEnabled, disabled: saving === 'flashbackEnabled', onChange: (v) => updateSetting('flashbackEnabled', v) })),
              h(SettingRow, { title: '增量建索引', desc: '仅在新记忆到达后触发，不阻塞检索', badge: h(Badge, { tone: 'blue' }, '5 分钟阈值') }, h(Toggle, { label: '增量建索引', value: !!s.vectorAutoBuildEnabled, disabled: saving === 'vectorAutoBuildEnabled', onChange: (v) => updateSetting('vectorAutoBuildEnabled', v) })))
          ),
          h('div', { className: 'pm-stack' },
            h(Card, { title: '索引健康', subtitle: '当前主索引快照', action: h(Badge, { tone: status.index.compatible ? 'good' : 'warn' }, status.index.compatible ? '兼容' : '待核查') },
              h('div', { className: 'pm-index' }, h('div', { className: 'pm-index-model' }, status.index.model),
                h('div', { className: 'pm-index-meta' }, h('div', null, h('div', { className: 'pm-meta-label' }, '记忆卡数量'), h('div', { className: 'pm-meta-value' }, fmt(status.index.count))), h('div', null, h('div', { className: 'pm-meta-label' }, '向量维度'), h('div', { className: 'pm-meta-value' }, status.index.dim || '—'))),
                h('div', { className: 'pm-meter-note' }, h('span', 'MODEL + DIMENSION'), h('span', status.index.compatible ? 'MATCHED' : 'CHECK')),
                h('div', { className: 'pm-meter' }, h('i', { style: { width: status.index.compatible ? '100%' : '24%' } })),
                h('div', { className: 'pm-stat-note' }, '构建时间 · ' + dateFmt(status.index.builtAt))),
              h('div', { className: 'pm-notice' }, '更换模型或维度必须重建索引。网页不提供直接重建，避免误删生产向量库。')),
            h(Card, { title: '运行约束', subtitle: '当前生效的系统边界' },
              h('div', { className: 'pm-card-pad' },
                h('div', { className: 'pm-local' }, h(Icon, { name: 'shield', size: 15 }), '密钥永不进入浏览器'),
                h('p', { className: 'pm-row-desc', style: { margin: '12px 0 18px' } }, '页面只读取 host、模型名与“已配置”状态；连通性测试由本机 Node 侧发起。'),
                h(Button, { onClick: () => setTab('models'), className: 'primary' }, '查看模型线路', h(Icon, { name: 'arrow', size: 13 })))))
        ));
    }

    function EndpointCard({ ep, result, testing, onTest, onEdit, pending }) {
      return h('article', { className: 'pm-endpoint' },
        h('div', { className: 'pm-endpoint-head' }, h('span', { className: 'pm-endpoint-id' }, ep.id), h('div', null, pending && h(Badge, { tone: 'warn' }, '待重启'), ' ', h(Badge, { tone: ep.enabled ? 'good' : 'warn' }, ep.enabled ? '已启用' : '未启用'))),
        h('div', { className: 'pm-endpoint-name' }, ep.name), h('div', { className: 'pm-endpoint-purpose' }, ep.purpose),
        h('div', { className: 'pm-endpoint-host', title: ep.host }, ep.host), h('div', { className: 'pm-endpoint-model' }, ep.model),
        h('div', { className: 'pm-endpoint-info' }, h('span', null, ep.path), h('span', null, '超时上限 ' + Math.round(ep.timeoutMs / 1000) + 's'), ep.dimensions && h('span', null, ep.dimensions + 'D')),
        h('div', { className: 'pm-endpoint-foot' }, h('div', null, h(Badge, { tone: ep.credential === '未配置' ? 'warn' : '' }, ep.credential), result && h('div', { className: 'pm-test-result ' + (result.ok ? 'good' : 'bad'), style: { marginTop: 7 } }, result.ok ? '连接正常 · ' + result.latencyMs + 'ms' : result.error || result.message)), h('div', { className: 'pm-endpoint-actions' }, h(Button, { onClick: onEdit }, '设置'), h(Button, { disabled: !ep.configured || testing || pending, title: pending ? '重启后测试新配置' : '', onClick: onTest }, testing ? '探测中…' : '测试连接'))));
    }

    function Models({ status, tests, testing, testEndpoint, updateSetting, saving, editEndpoint }) {
      const pending = status.runtime.restartRequired;
      return h(React.Fragment, null,
        h(PageHead, { title: '模型线路', desc: '四条独立线路，统一 OpenAI /v1 协议与故障降级策略。', action: h(Badge, { tone: 'blue' }, 'LOCAL CREDENTIALS · WRITE-ONLY') }),
        pending && h('div', { className: 'pm-notice', style: { margin: '0 0 16px' } }, '端点新配置已保存，但尚未生效。重启 DSH 后再执行连接测试；当前运行线路未被中途切换。'),
        h('div', { className: 'pm-endpoints' }, status.endpoints.map((ep) => h(EndpointCard, { key: ep.id, ep, pending, result: tests[ep.id], testing: testing === ep.id, onEdit: () => editEndpoint(ep), onTest: () => testEndpoint(ep) }))),
        h('div', { style: { height: 22 } }),
        h(Card, { title: '智能降级策略', subtitle: '在线抽取失败后使用备用 LLM；全部失败时安全跳过，不阻塞对话。' },
          h(SettingRow, { title: '抽取失败后的处理', desc: '启发式模式仅在固定槽位为空时补名，不替代模型输出。' }, h('select', { className: 'pm-select', value: status.settings.fallbackMode, disabled: saving === 'fallbackMode', onChange: (e) => updateSetting('fallbackMode', e.target.value) }, h('option', { value: 'off' }, '关闭降级'), h('option', { value: 'llm' }, '备用 LLM'), h('option', { value: 'heuristic' }, '启发式提取'))),
          h(SettingRow, { title: '备用模型凭据', desc: status.settings.fallbackLlm.host + ' · ' + (status.settings.fallbackLlm.model || '未配置模型'), badge: h(Badge, { tone: status.settings.fallbackLlm.credential === '已配置' ? 'good' : 'warn' }, status.settings.fallbackLlm.credential) }, h(Badge, null, '冷配置'))),
        h('div', { className: 'pm-notice', style: { margin: '18px 0 0' } }, '地址、模型与密钥保存到本机专用覆盖配置，重启 DSH 后生效；API Key 只在填写时写入，页面永不回显。E2 本地备路永远只用于查询，不参与建库。'));
    }

    function EndpointEditor({ ep, saving, onClose, onSave, onReset }) {
      const [draft, setDraft] = useState({
        baseUrl: ep.baseUrl || '', model: ep.model === '未配置' ? '' : ep.model,
        dimensions: ep.dimensions || 1024, timeoutMs: ep.timeoutMs || 12000, apiKey: '',
        startluxPort: Number((ep.baseUrl.match(/:(\d+)\//) || [])[1] || 8084), enabled: !!ep.enabled,
      });
      const set = (key, value) => setDraft((old) => ({ ...old, [key]: value }));
      const rerank = ep.id === 'R1';
      const vector = ep.id === 'E1' || ep.id === 'E2';
      return h('div', { className: 'pm-modal-mask', onClick: (e) => { if (e.target === e.currentTarget && !saving) onClose(); } },
        h('div', { className: 'pm-modal', role: 'dialog', 'aria-modal': true, 'aria-label': ep.name + '设置' },
          h('div', { className: 'pm-modal-head' }, h('div', null, h('span', { className: 'pm-endpoint-id' }, ep.id), h('div', { className: 'pm-modal-title' }, '设置' + ep.name)), h(Button, { className: 'pm-icon-btn', disabled: saving, onClick: onClose }, '×')),
          h('div', { className: 'pm-modal-body' },
            !rerank && h('div', { className: 'pm-form-field' }, h('label', { className: 'pm-form-label' }, 'Base URL'), h('input', { className: 'pm-input pm-mono', value: draft.baseUrl, placeholder: 'https://example.com/v1', onChange: (e) => set('baseUrl', e.target.value) }), h('div', { className: 'pm-form-help' }, '填写 OpenAI 兼容服务根地址，不要带查询参数或凭据。')),
            !rerank && h('div', { className: 'pm-form-field' }, h('label', { className: 'pm-form-label' }, '模型名'), h('input', { className: 'pm-input pm-mono', value: draft.model, onChange: (e) => set('model', e.target.value) })),
            !rerank && h('div', { className: 'pm-form-field' }, h('label', { className: 'pm-form-label' }, 'API Key（可选）'), h('input', { className: 'pm-input pm-mono', type: 'password', autoComplete: 'new-password', value: draft.apiKey, placeholder: '留空 = 保持现有密钥不变', onChange: (e) => set('apiKey', e.target.value) }), h('div', { className: 'pm-form-help' }, '只写入本机配置文件，不回显、不返回浏览器。')),
            rerank && h('div', { className: 'pm-form-field' }, h('label', { className: 'pm-form-label' }, '本地服务端口'), h('input', { className: 'pm-input pm-mono', type: 'number', min: 1024, max: 65535, value: draft.startluxPort, onChange: (e) => set('startluxPort', Number(e.target.value)) }), h('div', { className: 'pm-form-help' }, '地址固定为 127.0.0.1 / startlux。')),
            h('div', { className: 'pm-form-row' },
              vector && h('div', { className: 'pm-form-field' }, h('label', { className: 'pm-form-label' }, '向量维度'), h('input', { className: 'pm-input pm-mono', type: 'number', min: 1, max: 8192, value: draft.dimensions, onChange: (e) => set('dimensions', Number(e.target.value)) })),
              !rerank && h('div', { className: 'pm-form-field' }, h('label', { className: 'pm-form-label' }, '超时（秒）'), h('input', { className: 'pm-input pm-mono', type: 'number', min: 1, max: 120, value: draft.timeoutMs / 1000, onChange: (e) => set('timeoutMs', Number(e.target.value) * 1000) }))
            ),
            (ep.id === 'L1' || rerank) && h(SettingRow, { title: '启用此线路', desc: ep.id === 'L1' ? '关闭后抽取与蒸馏停止调用此模型。' : '关闭后跳过精排，向量与文本检索继续工作。' }, h(Toggle, { label: '启用此线路', value: draft.enabled, onChange: (v) => set('enabled', v) })),
            h('div', { className: 'pm-notice', style: { margin: 0 } }, ep.id === 'E1' ? '更换向量模型或维度后，旧索引会变为不兼容；需在维护窗口重建索引。' : '地址与运行参数即时保存；API Key 只在填写时写入，留空保持原样。保存后需重启 DSH 生效。')
          ),
          h('div', { className: 'pm-modal-foot' }, h(Button, { disabled: saving, onClick: onReset }, '恢复配置继承'), h('div', { className: 'pm-modal-actions' }, h(Button, { disabled: saving, onClick: onClose }, '取消'), h(Button, { className: 'primary', disabled: saving, onClick: () => onSave(draft) }, saving ? '保存中…' : '保存设置')))
        ));
    }

    const sliderGroups = [
      { title: '窗口与批处理', items: [
        ['batchMessages', '抽取窗口消息数', 4, 64, 1, ' 条'], ['minBatchMessages', '最短抽取批次', 1, 16, 1, ' 条'], ['distillWindowMessages', '蒸馏窗口消息数', 8, 100, 1, ' 条'], ['minDistillMessages', '最短蒸馏批次', 2, 20, 1, ' 条'],
      ] },
      { title: '调度与节奏', items: [
        ['extractIntervalMs', '抽取轮询间隔', 60000, 1800000, 60000, ' 分钟', 60000], ['distillMinGapMs', '蒸馏最短间隔', 0, 1800000, 60000, ' 分钟', 60000], ['maxWindowsPerRun', '每轮最多窗口', 1, 10, 1, ' 个'], ['temporalMinPool', '时间纯提及池', 1, 5, 1, ' 条'],
      ] },
      { title: '权重与生命周期', items: [
        ['concentrationGate', '浓缩门控', 0, 1, .05, '', 1, 2], ['concentrationAlpha', '浓缩增益', 0, 1, .01, '', 1, 2], ['retireAfterDays', '记忆退休天数', 1, 90, 1, ' 天'], ['coldArchiveAgeDays', '冷归档年龄', 7, 180, 1, ' 天'], ['coldArchiveImpMax', '冷归档重要性上限', 0, 1, .05, '', 1, 2],
      ] },
    ];

    function SliderControl({ item, value, onChange }) {
      const [key, label, min, max, step, unit, scale = 1, precision = 0] = item;
      const display = Number(value ?? min) / scale;
      return h('div', { className: 'pm-slider' },
        h('div', { className: 'pm-slider-head' }, h('span', { className: 'pm-slider-label' }, label), h('span', { className: 'pm-slider-value' }, display.toFixed(precision) + unit)),
        h('input', { type: 'range', min, max, step, value: Number(value ?? min), onChange: (e) => onChange(key, Number(e.target.value)), 'aria-label': label }),
        h('div', { className: 'pm-slider-range' }, h('span', null, (min / scale).toFixed(precision) + unit), h('span', null, (max / scale).toFixed(precision) + unit)));
    }

    function Pipeline({ status, updateSetting, saving, drafts, setDraft, saveDrafts, dirty }) {
      const s = status.settings;
      const toggles = [
        { title: '写入与巩固', items: [
          ['enabled', '记忆系统总开关', '关闭后停止捕获、抽取、蒸馏与自动刷新'], ['consolidationWindowEnabled', '巩固窗口', '处理滞后/超长窗口，避免活跃期间刷新干扰'], ['concentrationEnabled', '记忆浓度', '同主题重复时强化旧卡，不新增重复卡'], ['concentrationBoostEnabled', '浓度检索增益', '按真实使用 hits 加权，仍受相关性门控'], ['axiomStagingEnabled', '公理暂存', '高优先级公理先落暂存区，由 T1.2 发布'],
        ] },
        { title: '时间与向量', items: [
          ['temporalWindowEnabled', '时间窗口', '按场景归属时间增强记忆定位'], ['temporalEarliestEnabled', '最早提及', '保留首次提及的时间锚点'], ['temporalPureTimeProminence', '纯时间提及池', '为时间权重保留独立最小池'], ['eventTsEnabled', '事件时间戳', '记录事件时间，而非仅记录入库时间'], ['vectorAutoBuildEnabled', '向量增量构建', '低干扰阶段自动补齐新记忆索引'],
        ] },
        { title: '冷归档 · 谨慎操作', items: [
          ['coldArchiveEnabled', '冷归档', '按年龄和重要性扫描候选记忆'], ['coldArchiveAutoApply', '自动执行归档', '自动移动候选卡片；开启需要二次确认'],
        ] },
      ];
      return h(React.Fragment, null,
        h(PageHead, { title: '记忆管线', desc: '热配置即时生效；滑块调整完成后统一点击保存。', action: h(Badge, { tone: 'good' }, 'HOT RELOAD') }),
        h(Card, { title: '系统状态', subtitle: '总开关不修改任何模型与索引配置' }, h(SettingRow, { title: '启用 Assistant Memory', desc: '记忆写入、刷新与检索增强的总闸门。', badge: h(Badge, { tone: s.enabled ? 'good' : 'warn' }, s.enabled ? '运行中' : '已停止') }, h(Toggle, { label: '记忆系统总开关', value: !!s.enabled, disabled: saving === 'enabled', onChange: (v) => updateSetting('enabled', v) }))),
        h('div', { style: { height: 18 } }),
        toggles.map((group) => h('div', { className: 'pm-controls-section', key: group.title }, h('h3', { className: 'pm-controls-title' }, group.title), h(Card, null, group.items.map(([key, title, desc]) => h(SettingRow, { key, title, desc, badge: key === 'coldArchiveAutoApply' ? h(Badge, { tone: 'warn' }, '高风险') : null }, h(Toggle, { label: title, value: !!s[key], disabled: saving === key, onChange: (v) => updateSetting(key, v) })))))),
        h('div', { className: 'pm-section-head', style: { marginTop: 26 } }, h('div', null, h('h2', { className: 'pm-section-title', style: { fontSize: 17 } }, '参数调节'), h('div', { className: 'pm-section-desc' }, '输入范围由宿主侧二次校验并钳制。'))),
        sliderGroups.map((group) => h('div', { className: 'pm-controls-section', key: group.title }, h('h3', { className: 'pm-controls-title' }, group.title), h(Card, null, h('div', { className: 'pm-sliders' }, group.items.map((item) => h(SliderControl, { key: item[0], item, value: drafts[item[0]] ?? s[item[0]], onChange: setDraft })))))),
        h(Card, { title: '检索融合参数', subtitle: '当前为冷配置快照，修改后需重启 DSH。', action: h(Badge, null, 'READ ONLY') }, h('div', { className: 'pm-retrieval' }, [['Top K', status.retrieval.vectorTopK], ['最低向量分', status.retrieval.vectorMinScore], ['向量缩放', status.retrieval.vectorScale], ['向量权重', status.retrieval.wVector]].map(([label, value]) => h('div', { className: 'pm-retrieval-item', key: label }, h('div', { className: 'pm-meta-label' }, label), h('div', { className: 'pm-retrieval-value' }, value))))),
        dirty > 0 && h('div', { className: 'pm-savebar' }, h('span', { className: 'pm-savebar-text' }, dirty + ' 项参数尚未保存'), h(Button, { className: 'primary', disabled: saving === 'drafts', onClick: saveDrafts }, saving === 'drafts' ? '正在保存…' : '保存全部调整')));
    }

    function Telemetry({ status }) {
      const levels = status.telemetry.levels || [];
      const max = Math.max(1, ...levels.map((x) => x.count));
      return h(React.Fragment, null,
        h(PageHead, { title: '运行遥测', desc: '仅聚合事件级别、次数与耗时，不读取或展示记忆正文。', action: h(Badge, { tone: status.telemetry.available ? 'good' : 'warn' }, status.telemetry.available ? 'TAIL CONNECTED' : '暂无日志') }),
        h('div', { className: 'pm-telemetry-grid' }, levels.map((item) => h('div', { className: 'pm-telemetry-card', key: item.level },
          h('div', { className: 'pm-telemetry-name' }, item.level), h('div', { className: 'pm-telemetry-num' }, fmt(item.count)),
          h('div', { className: 'pm-meter' }, h('i', { style: { width: Math.max(item.count ? 4 : 0, item.count / max * 100) + '%' } })),
          h('div', { className: 'pm-telemetry-meta' }, levelNames[item.level] + ' · 均耗时 ' + item.avgMs + 'ms · ' + dateFmt(item.lastAt))))),
        h(Card, { title: '最近事件', subtitle: '最新 12 条脱敏遥测记录' }, status.telemetry.recent.length ? h('table', { className: 'pm-table' }, h('thead', null, h('tr', null, h('th', null, '事件'), h('th', null, '级别'), h('th', null, '耗时'), h('th', null, '计数'), h('th', null, '时间'))), h('tbody', null, status.telemetry.recent.map((event, i) => h('tr', { key: event.level + event.at + i }, h('td', null, levelNames[event.level]), h('td', { className: 'pm-mono' }, event.level), h('td', null, event.ms + ' ms'), h('td', null, event.count), h('td', null, dateFmt(event.at)))))) : h('div', { className: 'pm-empty' }, '暂无可聚合的遥测事件')),
        h('div', { className: 'pm-notice', style: { margin: '18px 0 0' } }, '遥测按 wake.log 尾部最多 512 KiB 增量口径聚合；它是运行观测窗口，不是完整历史审计。'));
    }

    function MemoryDashboard({ initialTab = 'overview', embedded = false }) {
      useEffect(mountStyle, []);
      const [tab, setTab] = useState(initialTab);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [saving, setSaving] = useState('');
      const [toast, setToast] = useState(null);
      const [tests, setTests] = useState({});
      const [testing, setTesting] = useState('');
      const [editing, setEditing] = useState('');
      const [endpointSaving, setEndpointSaving] = useState(false);
      const [drafts, setDrafts] = useState({});
      const alive = useRef(true);
      const rootRef = useRef(null);
      // 宿主嵌入抽屉里 CSS inline-size containment 会让宽度塌陷成竖条；
      // 改用 ResizeObserver 只读实测宽度打 data 档位，绝不反向影响布局。
      useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
          const w = entries[0].contentRect.width;
          el.dataset.pmW = w < 520 ? 'xs' : w < 640 ? 'sm' : w < 800 ? 'md' : w < 900 ? 'lg' : 'xl';
        });
        ro.observe(el);
        return () => ro.disconnect();
      }, []);
      useEffect(() => () => { alive.current = false; }, []);

      const notify = useCallback((message, tone = '') => {
        setToast({ message, tone });
        setTimeout(() => { if (alive.current) setToast(null); }, 2800);
      }, []);
      const load = useCallback(async (quiet = false) => {
        try {
          const next = await jget('/status');
          if (!alive.current) return;
          setStatus(next); setError('');
          if (!quiet) setDrafts({});
        } catch (e) { if (alive.current) setError(e.message || '状态读取失败'); }
      }, []);
      useEffect(() => { load(); const timer = setInterval(() => load(true), 30000); return () => clearInterval(timer); }, [load]);

      const updateSetting = useCallback(async (key, value) => {
        if (key === 'coldArchiveAutoApply' && value && !status.settings[key]) {
          if (!window.confirm('自动归档会实际移动符合条件的记忆卡。确认开启吗？')) return;
        }
        if (key === 'fallbackMode' && value === 'heuristic' && !window.confirm('启发式只会给固定空槽补名，可能产生不完整记忆。确认切换吗？')) return;
        setSaving(key);
        try {
          const body = { [key]: value };
          if (key === 'coldArchiveAutoApply' && value) body.confirmColdArchive = true;
          const result = await jpost('/config', body);
          if (!alive.current) return;
          setStatus((old) => ({ ...old, settings: result.config }));
          notify('已保存 · ' + (key === 'fallbackMode' ? '降级策略' : '热配置即时生效'));
        } catch (e) { notify(e.message, 'bad'); await load(true); }
        finally { if (alive.current) setSaving(''); }
      }, [status, notify, load]);
      const setDraft = useCallback((key, value) => setDrafts((old) => ({ ...old, [key]: value })), []);
      const saveDrafts = useCallback(async () => {
        if (!Object.keys(drafts).length) return;
        setSaving('drafts');
        try { const result = await jpost('/config', drafts); setStatus((old) => ({ ...old, settings: result.config })); setDrafts({}); notify('参数已保存并即时生效'); }
        catch (e) { notify(e.message, 'bad'); }
        finally { if (alive.current) setSaving(''); }
      }, [drafts, notify]);
      const testEndpoint = useCallback(async (ep) => {
        const target = ({ L1: 'llm', E1: 'embedding', E2: 'fallback', R1: 'rerank' })[ep.id];
        setTesting(ep.id);
        try { const result = await jpost('/test-connect', { target }); setTests((old) => ({ ...old, [ep.id]: result })); }
        catch (e) { setTests((old) => ({ ...old, [ep.id]: { ok: false, error: e.message } })); }
        finally { if (alive.current) setTesting(''); }
      }, []);

      const saveEndpoint = useCallback(async (draft) => {
        const ep = status?.endpoints.find((item) => item.id === editing);
        if (!ep) return;
        const target = ({ L1: 'llm', E1: 'embedding', E2: 'fallback', R1: 'rerank' })[ep.id];
        const body = { target };
        if (target === 'rerank') Object.assign(body, { startluxPort: draft.startluxPort, enabled: draft.enabled });
        else {
          Object.assign(body, { baseUrl: draft.baseUrl, model: draft.model, timeoutMs: draft.timeoutMs });
          if (target === 'llm') body.enabled = draft.enabled;
          else body.dimensions = draft.dimensions;
        }
        setEndpointSaving(true);
        try {
          await jpost('/endpoint-config', body);
          setEditing(''); setTests({}); notify('端点已保存 · 重启 DSH 后生效');
          await load(true);
        } catch (e) { notify(e.message, 'bad'); }
        finally { if (alive.current) setEndpointSaving(false); }
      }, [status, editing, notify, load]);
      const resetEndpoint = useCallback(async () => {
        const ep = status?.endpoints.find((item) => item.id === editing);
        if (!ep || !window.confirm('清除此线路的页面覆盖值，恢复继承原配置吗？')) return;
        const target = ({ L1: 'llm', E1: 'embedding', E2: 'fallback', R1: 'rerank' })[ep.id];
        setEndpointSaving(true);
        try { await jpost('/endpoint-config', { target, reset: true }); setEditing(''); setTests({}); notify('已恢复配置继承 · 重启后生效'); await load(true); }
        catch (e) { notify(e.message, 'bad'); }
        finally { if (alive.current) setEndpointSaving(false); }
      }, [status, editing, notify, load]);
      const dirty = Object.keys(drafts).length;
      const editingEndpoint = status?.endpoints.find((ep) => ep.id === editing);
      const activeLabel = (navItems.find((x) => x[0] === tab) || navItems[0])[2];
      if (!status && !error) return h('div', { className: 'pm-root pm-loading' }, '正在连接记忆中枢…');
      return h('div', { className: 'pm-root', ref: rootRef }, h('div', { className: 'pm-shell ' + (embedded ? 'pm-embedded' : '') },
        h('aside', { className: 'pm-side' },
          h('div', { className: 'pm-brand' }, h('div', { className: 'pm-brand-mark' }, h(Icon, { name: 'memory', size: 20 })), h('div', null, h('div', { className: 'pm-brand-name' }, 'UNIFIED MEMORY'), h('div', { className: 'pm-brand-sub' }, 'MEMORY OS'))),
          h('div', { className: 'pm-nav-label' }, 'CONSOLE'),
          navItems.map(([id, icon, label]) => h('button', { key: id, className: 'pm-nav ' + (tab === id ? 'active' : ''), onClick: () => setTab(id) }, h(Icon, { name: icon }), h('span', null, label))),
          h('div', { className: 'pm-side-bottom' }, h('div', { className: 'pm-local' }, h('span', { className: 'pm-dot' }), '本地安全运行'), h('div', { className: 'pm-version' }, 'OPENAI COMPATIBLE / v1'))
        ),
        h('main', { className: 'pm-main' },
          h('header', { className: 'pm-topbar' }, h('div', { className: 'pm-crumb' }, '记忆中枢  /  ' + activeLabel), h('div', { className: 'pm-top-actions' }, status && h(Badge, { tone: status.runtime.enabled ? 'good' : 'warn' }, status.runtime.enabled ? '系统在线' : '系统停用'), status?.runtime.restartRequired && h(Badge, { tone: 'warn' }, '端点待重启'), h(Button, { className: 'pm-icon-btn', title: '刷新状态', onClick: () => load() }, h(Icon, { name: 'refresh', size: 14 })))),
          h('div', { className: 'pm-content' },
            error && h('div', { className: 'pm-notice', style: { margin: '0 0 16px' } }, '连接异常：' + error + '。请确认 DSH 已重启加载新版插件。'),
            status && tab === 'overview' && h(Overview, { status, updateSetting, saving, setTab }),
            status && tab === 'pipeline' && h(Pipeline, { status, updateSetting, saving, drafts, setDraft, saveDrafts, dirty }),
            status && tab === 'models' && h(Models, { status, tests, testing, testEndpoint, updateSetting, saving, editEndpoint: (ep) => setEditing(ep.id) }),
            status && tab === 'telemetry' && h(Telemetry, { status }),
            h('footer', { className: 'pm-footer' }, h('span', null, '密钥不落前端 · 热设置原子写入 · 失败自动降级'), h('span', null, status ? 'LAST SYNC ' + dateFmt(status.now) : 'WAITING FOR RUNTIME'))
          ))
      ), editingEndpoint && h(EndpointEditor, { ep: editingEndpoint, saving: endpointSaving, onClose: () => setEditing(''), onSave: saveEndpoint, onReset: resetEndpoint }), toast && h('div', { className: 'pm-toast ' + toast.tone }, toast.message));
    }

    function AssistantMemoryPage() { return h(MemoryDashboard); }
    AssistantMemoryPage.displayName = 'Assistant Memory';

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots');
        // [2026-11-08 修复] 宿主没有 main.entries 槽（只有 main / sidebar.panellist / settings.section），
        //   旧写法被静默丢弃 ⇒ 主界面看不到入口。按第一方插件（schedule/plugin-manager）的写法注册：
        //   main 槽出整页，sidebar.panellist 出侧栏入口。
        slots.inject('main', () => slots.register(
          { name: 'main', key: 'unified-memory' },
          () => h(MemoryDashboard),
        ));
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'unified-memory', order: 10, label: () => '记忆中枢' },
          () => h(Icon, { name: 'memory', size: 16 }),
        ));
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'unified-memory', order: 10, label: () => '记忆中枢' },
          () => h(MemoryDashboard, { initialTab: 'pipeline', embedded: true }),
        ));
      },
    };
  },
});
