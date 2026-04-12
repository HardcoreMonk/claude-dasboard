// Claude Dashboard — chart module.
// Extracted from app.js for modularity. This file is loaded as a regular
// (non-module) script after app.js, so top-level `function foo(){}`
// declarations become window.foo. It depends on these globals defined in
// app.js: state, state.charts, safeFetch, fmtTok, shortModel, savePrefs,
// projectData, renderProjectDailyChart.

const CC={emerald:'#34d399',blue:'#60a5fa',amber:'#fbbf24',rose:'#fb7185',cyan:'#22d3ee',purple:'#a78bfa'};
// Theme-aware chart palette. All chart instances consult these at render
// time, and refreshChartsForTheme() rebuilds any live instance on toggle.
function themeColors() {
  if (document.body.classList.contains('theme-light')) return {
    gridColor:    'rgba(0,0,0,.06)',
    tickColor:    'rgba(0,0,0,.55)',
    legendColor:  'rgba(0,0,0,.65)',
    tooltipBg:    '#ffffff',
    tooltipBorder:'rgba(0,0,0,.12)',
    tooltipTitle: 'rgba(0,0,0,.80)',
    tooltipBody:  'rgba(0,0,0,.60)',
  };
  return {
    gridColor:    'rgba(255,255,255,.03)',
    tickColor:    'rgba(255,255,255,.35)',
    legendColor:  'rgba(255,255,255,.45)',
    tooltipBg:    '#111',
    tooltipBorder:'rgba(255,255,255,.08)',
    tooltipTitle: 'rgba(255,255,255,.7)',
    tooltipBody:  'rgba(255,255,255,.5)',
  };
}
const CHART_D={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},animation:{duration:400}};
function grd(){return{color:themeColors().gridColor,drawBorder:false};}
function tck(){return{color:themeColors().tickColor,font:{size:11,family:'Pretendard'}};}
function legendLabels(extra={}){return{color:themeColors().legendColor,boxWidth:10,font:{size:11,family:'Pretendard'},...extra};}
function tooltipOpts(extra={}){
  const c=themeColors();
  return{backgroundColor:c.tooltipBg,borderColor:c.tooltipBorder,borderWidth:1,titleColor:c.tooltipTitle,bodyColor:c.tooltipBody,...extra};
}
// Per-chart error overlay. Inject on top of the canvas wrapper so a
// failing chart doesn't render as a silent blank canvas.
function chartError(canvasId, err, retryFn) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.parentElement) return;
  const wrap = canvas.parentElement;
  wrap.querySelectorAll('.chart-err-overlay').forEach(n => n.remove());
  const overlay = document.createElement('div');
  overlay.className = 'chart-err-overlay absolute inset-0 flex flex-col items-center justify-center text-center bg-white/[0.02] ring-1 ring-red-500/20 rounded-lg';
  const icon = document.createElement('iconify-icon');
  icon.setAttribute('icon', 'solar:danger-triangle-linear');
  icon.setAttribute('width', '24');
  icon.className = 'text-red-400/60 mb-1';
  const title = document.createElement('div');
  title.className = 'text-[11px] font-bold text-red-300/80';
  title.textContent = '차트 로딩 실패';
  const msg = document.createElement('div');
  msg.className = 'text-[10px] text-white/40 mt-0.5 max-w-[80%] truncate';
  msg.textContent = (err && err.message) || String(err || '');
  msg.title = msg.textContent;
  overlay.append(icon, title, msg);
  if (retryFn) {
    const btn = document.createElement('button');
    btn.className = 'mt-2 px-2.5 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 text-[10px] font-bold spring hover:scale-[1.02]';
    btn.textContent = '다시 시도';
    btn.addEventListener('click', () => { overlay.remove(); retryFn(); });
    overlay.appendChild(btn);
  }
  // parent needs relative positioning for absolute overlay
  if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
  wrap.appendChild(overlay);
}
async function loadCharts(){
  await Promise.allSettled([
    loadUsageChart().catch(e => { console.error('usage chart:', e); chartError('chartUsage', e, loadUsageChart); }),
    loadModelChart().catch(e => { console.error('models chart:', e); chartError('chartModels', e, loadModelChart); }),
    loadDailyCostChart().catch(e => { console.error('daily cost chart:', e); chartError('chartDailyCost', e, loadDailyCostChart); }),
    loadCacheChart().catch(e => { console.error('cache chart:', e); chartError('chartCache', e, loadCacheChart); }),
    loadStopReasonChart().catch(e => { console.error('stop reason chart:', e); chartError('chartStopReason', e, loadStopReasonChart); }),
    loadModelCacheChart().catch(e => { console.error('model cache chart:', e); chartError('chartModelCache', e, loadModelCacheChart); }),
  ]);
}
// Theme toggle hook: destroy + rebuild active chart instances so colors flip.
function refreshChartsForTheme(){
  const hasCostCharts=['usage','models','dailyCost','cache','stopReason','modelCache'].some(k=>state.charts[k]);
  if(hasCostCharts)loadCharts();
  if(state.charts.projDaily&&typeof projectData!=='undefined'&&projectData?.daily?.length){
    renderProjectDailyChart(projectData.daily);
  }
}

async function loadUsageChart(){
  const h=state.usageRange==='24h'?24:state.usageRange==='7d'?168:720;
  const ep=h<=168?`/api/usage/hourly?hours=${h}`:`/api/usage/daily?days=30`;
  const data=await safeFetch(ep);const rows=data.data||[];
  const labels=rows.map(r=>r.hour||r.date||''),inp=rows.map(r=>r.input_tokens||0),out=rows.map(r=>r.output_tokens||0),cr=rows.map(r=>r.cache_read_tokens||0);
  if(state.charts.usage)state.charts.usage.destroy();
  state.charts.usage=new Chart(document.getElementById('chartUsage'),{type:'line',data:{labels,datasets:[
    {label:'입력',data:inp,borderColor:CC.blue,backgroundColor:'rgba(96,165,250,.08)',fill:true,tension:.3,pointRadius:1.5,borderWidth:1.5},
    {label:'출력',data:out,borderColor:CC.emerald,backgroundColor:'rgba(52,211,153,.06)',fill:true,tension:.3,pointRadius:1.5,borderWidth:1.5},
    {label:'캐시',data:cr,borderColor:CC.cyan,backgroundColor:'rgba(34,211,238,.04)',fill:true,tension:.3,pointRadius:1,borderWidth:1,borderDash:[4,2]},
  ]},options:{...CHART_D,plugins:{legend:{display:true,position:'top',align:'end',labels:legendLabels()},tooltip:tooltipOpts({callbacks:{label:c=>`${c.dataset.label}: ${fmtTok(c.raw)}`}})},scales:{x:{grid:grd(),ticks:{...tck(),maxTicksLimit:8,maxRotation:0}},y:{grid:grd(),ticks:{...tck(),callback:v=>fmtTok(v)}}}}});
}
async function loadModelChart(){
  const data=await safeFetch('/api/models');const rows=data.models||[];
  const labels=rows.map(r=>shortModel(r.model)),vals=rows.map(r=>parseFloat((r.cost_usd||0).toFixed(4)));
  const pal=[CC.emerald,CC.blue,CC.amber,CC.rose,CC.cyan,CC.purple];
  if(state.charts.models)state.charts.models.destroy();
  state.charts.models=new Chart(document.getElementById('chartModels'),{type:'doughnut',data:{labels,datasets:[{data:vals,backgroundColor:pal.map(c=>c+'66'),borderColor:pal,borderWidth:1,hoverOffset:4}]},options:{...CHART_D,cutout:'65%',plugins:{legend:{display:true,position:'right',labels:legendLabels({boxWidth:8,padding:6})},tooltip:tooltipOpts({callbacks:{label:c=>` ${c.label}: $${c.raw.toFixed(2)}`}})}}});
}
async function loadDailyCostChart(){
  const data=await safeFetch('/api/usage/daily?days=30');const rows=data.data||[];
  const labels=rows.map(r=>r.date?r.date.slice(5):''),costs=rows.map(r=>parseFloat((r.cost_usd||0).toFixed(4)));
  if(state.charts.dailyCost)state.charts.dailyCost.destroy();
  state.charts.dailyCost=new Chart(document.getElementById('chartDailyCost'),{type:'bar',data:{labels,datasets:[{label:'비용',data:costs,backgroundColor:'rgba(52,211,153,.25)',borderColor:CC.emerald,borderWidth:1,borderRadius:3}]},options:{...CHART_D,plugins:{tooltip:tooltipOpts({callbacks:{label:c=>` $${c.raw.toFixed(4)}`}})},scales:{x:{grid:grd(),ticks:{...tck(),maxTicksLimit:10}},y:{grid:grd(),ticks:{...tck(),callback:v=>'$'+v}}}}});
}
async function loadCacheChart(){
  const data=await safeFetch('/api/stats');const a=data.all_time||{};
  const d=[a.input_tokens||0,a.cache_creation_tokens||0,a.cache_read_tokens||0,a.output_tokens||0];
  if(state.charts.cache)state.charts.cache.destroy();
  state.charts.cache=new Chart(document.getElementById('chartCache'),{type:'doughnut',data:{labels:['입력','캐시 생성','캐시 읽기','출력'],datasets:[{data:d,backgroundColor:[CC.blue+'66',CC.purple+'66',CC.cyan+'66',CC.emerald+'66'],borderColor:[CC.blue,CC.purple,CC.cyan,CC.emerald],borderWidth:1,hoverOffset:4}]},options:{...CHART_D,cutout:'60%',plugins:{legend:{display:true,position:'right',labels:legendLabels({boxWidth:8,padding:5})},tooltip:tooltipOpts({callbacks:{label:c=>` ${c.label}: ${fmtTok(c.raw)}`}})}}});
}
async function loadStopReasonChart(){
  const data=await safeFetch('/api/stats');const rows=data.stop_reasons||[];
  if(!rows.length)return;
  const SR_LABELS={'end_turn':'정상 종료','tool_use':'도구 호출','max_tokens':'토큰 초과','(unknown)':'미분류'};
  const labels=rows.map(r=>SR_LABELS[r.stop_reason]||r.stop_reason);
  const counts=rows.map(r=>r.count||0);
  const pal=[CC.emerald,CC.blue,CC.amber,CC.rose,CC.cyan,CC.purple];
  if(state.charts.stopReason)state.charts.stopReason.destroy();
  state.charts.stopReason=new Chart(document.getElementById('chartStopReason'),{type:'doughnut',data:{labels,datasets:[{data:counts,backgroundColor:pal.map(c=>c+'66'),borderColor:pal,borderWidth:1,hoverOffset:4}]},options:{...CHART_D,cutout:'60%',plugins:{legend:{display:true,position:'right',labels:legendLabels({boxWidth:8,padding:5})},tooltip:tooltipOpts({callbacks:{label:c=>{const total=c.dataset.data.reduce((a,b)=>a+b,0);const pct=total>0?(c.raw/total*100).toFixed(1):'0';return ` ${c.label}: ${fmtN(c.raw)} (${pct}%)`;}}})}}});
}
async function loadModelCacheChart(){
  const data=await safeFetch('/api/stats');const rows=data.model_cache||[];
  if(!rows.length)return;
  const labels=rows.map(r=>shortModel(r.model));
  const hitRates=rows.map(r=>{const total=(r.input_tokens||0)+(r.cache_read_tokens||0);return total>0?((r.cache_read_tokens||0)/total*100):0;});
  if(state.charts.modelCache)state.charts.modelCache.destroy();
  state.charts.modelCache=new Chart(document.getElementById('chartModelCache'),{type:'bar',data:{labels,datasets:[{label:'캐시 히트율 %',data:hitRates,backgroundColor:'rgba(34,211,238,.3)',borderColor:CC.cyan,borderWidth:1,borderRadius:3}]},options:{...CHART_D,indexAxis:'y',plugins:{tooltip:tooltipOpts({callbacks:{label:c=>` ${c.raw.toFixed(1)}%`}})},scales:{x:{grid:grd(),ticks:{...tck(),callback:v=>v+'%'},max:100},y:{grid:grd(),ticks:tck()}}}});
}
function setUsageRange(btn,range){
  document.querySelectorAll('.chart-range').forEach(b=>{b.classList.remove('active');b.classList.add('text-white/20');b.classList.remove('text-white/40');});
  btn.classList.add('active','text-white/40');btn.classList.remove('text-white/20');
  state.usageRange=range;
  savePrefs({ usageRange: range });
  loadUsageChart();
}
