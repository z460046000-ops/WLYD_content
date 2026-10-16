import { readFile } from 'node:fs/promises'
import { validatePresentationHtml } from './validate.js'

const list = value => Array.isArray(value) ? value : []
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const safeJson = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
const trustedScript = value => value.replace(/<\/script/giu, '<\\/script')
const themes = new Set(['editorial', 'blueprint', 'museum', 'launch', 'swiss'])

const STYLE = `
body{background:#101112!important;color:#f2f2ef;font-family:'PingFang SC','Microsoft YaHei',sans-serif}
body>div:not(#stage):not(#presentation-controls){display:none!important}
#stage{--muted:#a7aaa9;--accent:#5979ff;background:var(--bg);color:var(--fg)}
.slide{position:absolute;inset:0;padding:88px 110px 106px;display:flex;flex-direction:column;background:var(--bg);color:var(--fg)}
.slide.light{background:var(--paper,#f2f2ef);color:var(--ink,#141516);--muted:#555b59}
.over{display:flex;justify-content:space-between;gap:30px;align-items:center;font:500 22px/1.4 var(--font-ui);letter-spacing:.08em;color:var(--muted)}
.chapter-title{max-width:1200px;overflow-wrap:anywhere}
.mode-tag{border:1px solid currentColor;border-radius:30px;padding:8px 16px;white-space:nowrap;font-size:18px;letter-spacing:0}
h1,h2{font:650 72px/1.24 var(--font-display);letter-spacing:-.025em;margin-top:40px;max-width:1640px;overflow-wrap:anywhere}
.keypoints{list-style:none;margin-top:36px;display:grid;gap:22px;max-width:1600px}
.keypoints li{display:grid;grid-template-columns:40px 1fr;gap:18px;font:400 34px/1.44 var(--font-body);overflow-wrap:anywhere}
.point-number{font:400 22px/1.9 var(--font-ui);color:var(--accent);font-variant-numeric:tabular-nums}
.empty-note{font:400 40px/1.5 var(--font-body);margin-top:42px;max-width:1500px;overflow-wrap:anywhere}
.boundary{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px;max-width:1600px}
.boundary span{font:500 20px/1.4 var(--font-body);border-left:3px solid var(--accent);padding-left:12px;color:var(--muted)}
.trace{margin-top:auto;padding-top:22px;max-width:1600px;font:400 17px/1.5 var(--font-ui);color:var(--muted);overflow-wrap:anywhere}
.foot{position:absolute;left:110px;right:110px;bottom:42px;z-index:60;display:flex;justify-content:space-between;gap:30px;color:#727972;font:500 18px/1.4 var(--font-ui)}
.foot-title{max-width:900px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
#deck-num{font-variant-numeric:tabular-nums}
#deck-progress{position:absolute;left:0;bottom:0;height:5px;width:0;background:var(--accent);transform:none!important;z-index:60}
#presentation-controls{position:fixed;bottom:0;left:0;right:0;height:56px;display:flex;gap:10px;align-items:center;justify-content:center;padding:6px 16px;background:#101112;color:#f2f2ef;z-index:100000;font-size:14px}
#presentation-controls button{height:40px;min-width:44px;padding:0 14px;border:1px solid #424745;border-radius:7px;background:#222624;color:inherit;font:inherit;cursor:pointer}
#presentation-controls button:hover{background:#363e39}
#presentation-controls button:active{background:#455149}
#presentation-controls button:focus-visible{outline:3px solid #93a9ff;outline-offset:2px}
#presentation-controls button:disabled{opacity:.4;cursor:default}
.render-output #presentation-controls{display:none}
#presentation-position{min-width:90px;text-align:center;font-variant-numeric:tabular-nums}
.keyboard-hint{color:#a7aaa9;margin-left:14px}
dialog{margin:auto;width:min(980px,92vw);max-height:88vh;padding:26px 32px;background:#f4f3ee;color:#17201b;border:0;border-radius:12px;overflow:auto;font:16px/1.7 'PingFang SC','Microsoft YaHei',sans-serif;z-index:200000}
dialog::backdrop{background:#000b}
dialog h2{font-size:26px;line-height:1.4;margin:12px 0}
dialog h3{font-size:19px;margin-top:20px}
dialog p{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}
dialog button{float:right;position:sticky;top:0;border:1px solid #b0b8b2;padding:7px 14px;border-radius:6px;background:#fff;color:#17201b;cursor:pointer}
dialog .metadata{font-size:13px;color:#59635d}
dialog article{border-top:1px solid #c9cfc8;margin-top:18px;padding-top:10px}
@media(max-width:700px){
 body:not(.render-output) #stage{transform:none!important;width:100vw!important;height:calc(100dvh - 56px)!important;left:0!important;top:0!important}
 body:not(.render-output) .slide{padding:28px 24px 46px;overflow-y:auto;overscroll-behavior:contain}
 body:not(.render-output) .over{font-size:12px;gap:10px;align-items:flex-start}body:not(.render-output) .chapter-title{max-width:210px}body:not(.render-output) .mode-tag{font-size:10px;padding:5px 8px}
 body:not(.render-output) h2{font-size:28px;line-height:1.28;margin-top:26px;letter-spacing:-.02em}
 body:not(.render-output) .keypoints{gap:16px;margin-top:24px}body:not(.render-output) .keypoints li{font-size:18px;line-height:1.55;grid-template-columns:22px 1fr;gap:10px}body:not(.render-output) .point-number{font-size:12px;line-height:2.3}
 body:not(.render-output) .boundary{gap:9px;margin-top:22px}body:not(.render-output) .boundary span{font-size:11px;padding-left:7px;border-left-width:2px}
 body:not(.render-output) .trace{font-size:11px;padding-top:24px;margin-top:0}body:not(.render-output) .empty-note{font-size:20px;line-height:1.6;margin-top:28px}
 body:not(.render-output) .foot{display:none}body:not(.render-output) #deck-progress{height:3px}
 .keyboard-hint{display:none}#presentation-controls{gap:5px;padding-inline:6px}#presentation-controls button{padding:0 9px}#presentation-position{min-width:58px}
}
@media print{body{overflow:visible!important;background:white!important}#stage{position:static!important;transform:none!important;width:100%!important;height:auto!important;overflow:visible!important}.slide{position:relative!important;display:flex!important;opacity:1!important;transform:none!important;clip-path:none!important;width:1920px;height:1080px;page-break-after:always}.slide [data-fx]{opacity:1!important;transform:none!important;clip-path:none!important}#presentation-controls,.foot,#deck-progress,dialog{display:none!important}}
`

function pageHtml(slide, index) {
  const boundaries = list(slide.boundaries)
  const mode = slide.kind === 'material-card' ? '待补材料' : slide.mode === 'source-pagination' ? '原文分页 · 未精简' : '关键点演示'
  const points = list(slide.points).filter(point => point.text !== slide.title || list(slide.points).length === 1)
  return `<section class="slide${index % 2 === 1 ? ' light' : ''}" data-slide-id="${escapeHtml(slide.id)}" data-dur="5" data-tr="push">
  <div class="over" data-fx="fade"><span class="chapter-title">${escapeHtml(slide.sectionTitle)}</span><span class="mode-tag">${escapeHtml(mode)}</span></div>
  <h2 data-fx="rise" data-in="0.1">${escapeHtml(slide.title)}</h2>
  ${slide.kind === 'material-card' ? `<p class="empty-note" data-fx="rise" data-in="0.2">${escapeHtml(slide.reason)}</p>`
    : `<ol class="keypoints">${points.map((point, pointIndex) => `<li data-fx="rise" data-in="${0.2 + pointIndex * 0.12}"><span class="point-number">${String(pointIndex + 1).padStart(2, '0')}</span><span>${escapeHtml(point.text)}</span></li>`).join('')}</ol>`}
  ${boundaries.length ? `<div class="boundary">${boundaries.map(label => `<span>${escapeHtml(label)}</span>`).join('')}</div>` : ''}
  <p class="trace">${slide.continuation ? '原文续页：同一段落的适用条件仍然有效 · ' : ''}${slide.kind === 'material-card' ? '材料卡不计为已完成正文' : '来源与原文可在下方查看'}${list(slide.sourceConditions).length ? ' · 含适用条件，请同时查看原文' : ''}</p>
</section>`
}

function sourceHtml(plan) {
  return list(plan.sources).map(source => `<article data-source-key="${escapeHtml(JSON.stringify([source.sectionKey, source.id]))}">
  <h3>${escapeHtml(source.sectionTitle)} · ${escapeHtml(source.id)}</h3>
  <p class="metadata">${escapeHtml(list(source.boundaries).join(' · '))}</p>
  <p>${escapeHtml(source.text)}</p>
  ${list(source.conditions).length ? `<p>适用条件：${escapeHtml(source.conditions.join('；'))}</p>` : ''}
  ${list(source.evidence).map(ref => `<p class="metadata">来源 ${escapeHtml(ref.id)}${ref.locator ? ` · ${escapeHtml(typeof ref.locator === 'string' ? ref.locator : JSON.stringify(ref.locator))}` : ''}${ref.quote ? `<br>${escapeHtml(ref.quote)}` : ''}</p>`).join('')}
  </article>`).join('')
}

/** User/model strings only enter escaped text nodes; trusted local engine code is embedded verbatim. */
export async function renderPresentation(plan, { theme = 'editorial' } = {}) {
  if (!list(plan?.slides).length) throw new Error('没有可渲染的演示页面')
  const selectedTheme = themes.has(theme) ? theme : 'editorial'
  const [base, tokens, runtime, deck] = await Promise.all(['base.css', 'themes.css', 'runtime.js', 'deck.js'].map(file =>
    readFile(new URL(`../../../vendor/xiaoma-studio/engine/${file}`, import.meta.url), 'utf8')))
  const ready = plan.assemblyReview?.passed === true && list(plan.sourceVersions).every(section => section.approvalStatus === 'approved')
  const reviewLabel = ready ? '已确认文案 · 演示视图' : '工作稿 · 待用户确认与复核'
  const pageSources = plan.slides.map(slide => list(slide.sourceBlockIds).map(id => JSON.stringify([slide.sectionKey, id])))
  const controls = `
(function(){
  'use strict';
  // Keep the upstream rendering timeline and bypass only its auto-playing presenter controls.
  const exporting=MS.RENDER;
  if(exporting)document.body.classList.add('render-output');
  MS.RENDER=true;
  const timeline=MS.deck({width:1920,height:1080,fps:30,background:'#101112'});
  const marks=window.__ms.marks, sources=${safeJson(pageSources)};
  const seek=window.__ms.seek, progress=document.getElementById('deck-progress');
  // A layout width avoids a first-capture compositor race in transform-only progress bars.
  window.__ms.seek=async value=>{
    await seek(value);progress.style.width=(Math.max(0,Math.min(1,value/window.__ms.meta.duration))*100)+'%';
    document.getElementById('stage').getBoundingClientRect();
    // Capture readiness only: the upstream frame itself remains a pure function of time.
    await new Promise(resolve=>requestAnimationFrame(resolve));
  };
  let index=0, revision=0;
  const position=document.getElementById('presentation-position');
  const prev=document.getElementById('presentation-prev'), next=document.getElementById('presentation-next');
  const dialog=document.getElementById('presentation-sources');
  const items=[...dialog.querySelectorAll('article')];
  async function go(value){
    index=Math.max(0,Math.min(marks.length-1,value));
    const current=++revision;
    await window.__ms.seek(marks[index]);
    if(current!==revision)return;
    position.textContent=(index+1)+' / '+marks.length;
    document.getElementById('deck-num').textContent=position.textContent;
    progress.style.width=(((index+1)/marks.length)*100)+'%';
    prev.disabled=index===0;next.disabled=index===marks.length-1;
    document.querySelectorAll('.slide').forEach((element,page)=>element.setAttribute('aria-hidden',String(page!==index)));
    document.title=${safeJson(plan.title)}+' · '+position.textContent;
  }
  const fullscreen=()=>{if(document.fullscreenElement)document.exitFullscreen?.();else document.documentElement.requestFullscreen?.().catch(()=>{});};
  prev.onclick=()=>go(index-1);next.onclick=()=>go(index+1);
  document.getElementById('presentation-fullscreen').onclick=fullscreen;
  document.getElementById('presentation-source-open').onclick=()=>{items.forEach(item=>item.hidden=!sources[index].includes(item.dataset.sourceKey));dialog.showModal();};
  document.getElementById('presentation-source-close').onclick=()=>dialog.close();
  addEventListener('keydown',event=>{
    if(dialog.open)return;
    let action;
    if(['ArrowRight','ArrowDown','PageDown','Enter',' '].includes(event.key))action=()=>go(index+1);
    if(['ArrowLeft','ArrowUp','PageUp'].includes(event.key))action=()=>go(index-1);
    if(event.key==='Home')action=()=>go(0);
    if(event.key==='End')action=()=>go(marks.length-1);
    if(event.key.toLowerCase()==='f')action=fullscreen;
    if(action){event.preventDefault();event.stopImmediatePropagation();action();}
  },true);
  window.__presentation={go,next:()=>go(index+1),previous:()=>go(index-1),get index(){return index;},count:marks.length,timeline};
  if(!exporting)go(0);
})();`
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="wlyd-source-content-sha256" content="${escapeHtml(plan.sourceContentSha256)}">
<meta name="wlyd-xiaoma-commit" content="${escapeHtml(plan.skill?.commit)}">
<meta name="wlyd-xiaoma-rules-sha256" content="${escapeHtml(plan.skill?.hash)}">
<title>${escapeHtml(plan.title)}</title><style>${base}\n${tokens}\n${STYLE}</style></head>
<body><div id="stage" class="theme-${selectedTheme}" aria-label="解决方案演示">
${plan.slides.map(pageHtml).join('\n')}
<div class="foot"><span class="foot-title">${escapeHtml(plan.title)} · ${escapeHtml(reviewLabel)}</span><span id="deck-num"></span></div><div id="deck-progress"></div></div>
<div id="presentation-controls" role="navigation" aria-label="幻灯片翻页">
<button type="button" id="presentation-prev" aria-label="上一页">← 上一页</button><span id="presentation-position" aria-live="polite"></span>
<button type="button" id="presentation-next" aria-label="下一页">下一页 →</button><button type="button" id="presentation-source-open">原文与来源</button><button type="button" id="presentation-fullscreen">全屏</button><span class="keyboard-hint">← → 翻页 · F 全屏</span></div>
<dialog id="presentation-sources"><button type="button" id="presentation-source-close">关闭</button><h2>本页原文与来源</h2><p class="metadata">演示只选择原文关键句。完整措辞、适用条件与审核身份以本文及已交付文档为准。</p>${sourceHtml(plan)}
${list(plan.warnings).length ? `<h3>输出说明</h3><p class="metadata">${escapeHtml(plan.warnings.join('\n'))}</p>` : ''}</dialog>
<script>${trustedScript(runtime)}</script><script>${trustedScript(deck)}</script><script>${controls}</script>
</body></html>`
  const issues = validatePresentationHtml(html)
  if (issues.length) throw new Error(issues.join('；'))
  return html
}
