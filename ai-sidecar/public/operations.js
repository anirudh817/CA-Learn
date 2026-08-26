const state={summary:null,runs:[],turns:[],selected:"",detail:null,tab:"overview",runId:"",status:"",refreshing:false,openPayloads:new Set(),timelineSig:"",inspectorSig:"",research:null,
  view:"chat",researchSelected:"",researchTab:"overview",researchOpen:new Set(),researchOutputs:{},researchCatalog:{},researchById:{},researchSig:"",mounted:""};
const esc=(value)=>String(value??"").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const api=async(url)=>{const response=await fetch(url);if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.detail||`Request failed (${response.status})`)}return response.json()};
const ms=(value)=>value==null?"—":Number(value)<1000?`${Number(value).toFixed(0)} ms`:`${(Number(value)/1000).toFixed(2)} s`;
const bytes=(value)=>Number(value||0)<1024?`${Number(value||0)} B`:Number(value)<1048576?`${(Number(value)/1024).toFixed(1)} KB`:`${(Number(value)/1048576).toFixed(1)} MB`;
const money=(value)=>`$${Number(value||0).toFixed(4)}`;
const stamp=(value)=>value?new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—";
const baseName=(value)=>String(value||"").split("/").pop()||String(value||"");
const generatedCodeIntent=(text)=>{const first=String(text||"").split(/\r?\n/,1)[0]||"";const match=first.match(/^\s*#\s*Intent\s*:\s*(.+)$/i);return match?match[1].trim():""};

async function refresh(){
  if(state.refreshing)return;state.refreshing=true;
  try{
    const query=new URLSearchParams();if(state.runId)query.set("runId",state.runId);if(state.status)query.set("status",state.status);query.set("limit","150");
    const [summary,turnsPayload,runsPayload,researchPayload]=await Promise.all([
      api(`/api/operations/summary${state.runId?`?runId=${encodeURIComponent(state.runId)}`:""}`),
      api(`/api/operations/turns?${query}`),
      state.runs.length?Promise.resolve({runs:state.runs}):api("/api/runs"),
      api(`/api/operations/research${state.runId?`?runId=${encodeURIComponent(state.runId)}`:""}`).catch(()=>({summary:null,jobs:[]})),
    ]);
    state.summary=summary;state.turns=turnsPayload.turns;state.runs=runsPayload.runs;state.research=researchPayload;
    if(!state.selected||!state.turns.some((turn)=>turn.id===state.selected))state.selected=state.turns[0]?.id||"";
    state.detail=state.selected?await api(`/api/operations/turns/${encodeURIComponent(state.selected)}`):null;
    const jobs=(state.research&&state.research.jobs)||[];
    // Re-run children are excluded from the list (they thread under their parent), yet
    // remain selectable via the "Open child extension job" drill-in. Resolve a selected-
    // but-unlisted job by id into a side cache so the detail pane keeps it and the 2s
    // poll doesn't snap the selection back to the first parent.
    const listed=jobs.some((job)=>job.id===state.researchSelected);
    if(state.researchSelected&&!listed)state.researchById[state.researchSelected]=await api(`/api/operations/research/${encodeURIComponent(state.researchSelected)}`).catch(()=>state.researchById[state.researchSelected]||null);
    if(!state.researchSelected||(!listed&&!state.researchById[state.researchSelected]))state.researchSelected=jobs[0]?.id||"";
    render();
  }catch(error){document.querySelector("#operations-root").innerHTML=`<div class="empty"><h2>Control center unavailable</h2><p>${esc(error.message)}</p></div>`}
  finally{state.refreshing=false}
}

function shell(){return `<div class="ops"><header class="topbar"><div class="brand"><span class="mark">SF</span><div><h1>AI Insights · Operational Control Center</h1><p>Developer-only, read-only telemetry from the canonical Pi sidecar</p></div></div><div class="top-actions"><div class="view-toggle"><button class="vtab" data-view="chat">Chat turns</button><button class="vtab" data-view="research">Research jobs</button></div><span class="live">polling every 2s</span><a class="btn" href="/" target="_blank" rel="noopener">Open AI Insights</a><button class="btn" id="refresh">Refresh now</button></div></header><section class="summary"><div id="kpis" class="kpis"></div><div class="filters"><select id="runFilter" class="control"></select><select id="statusFilter" class="control"><option value="">All states</option><option value="running">Running</option><option value="complete">Complete</option><option value="failed">Failed</option><option value="blocked">Blocked</option></select></div><div id="warnings" class="warning-strip"></div></section><section class="view-host" id="viewHost"></section></div>`}

function render(){
  const root=document.querySelector("#operations-root");if(!root.querySelector(".ops"))root.innerHTML=shell();
  root.querySelectorAll(".vtab").forEach((tab)=>tab.classList.toggle("active",tab.dataset.view===state.view));
  renderKpis();
  root.querySelector("#warnings").innerHTML=(state.summary.warnings||[]).map((warning)=>`<span class="warning">${esc(warning)}</span>`).join("");
  root.querySelector("#runFilter").innerHTML=`<option value="">All completed runs</option>${state.runs.map((run)=>`<option value="${esc(run.id)}" ${run.id===state.runId?"selected":""}>${esc(run.name||run.id)}</option>`).join("")}`;
  root.querySelector("#statusFilter").value=state.status;
  root.querySelector("#statusFilter").classList.toggle("hidden",state.view!=="chat");
  if(state.mounted!==state.view){
    const host=document.querySelector("#viewHost");
    host.className=`view-host ${state.view}`;
    host.innerHTML=state.view==="chat"?chatSkeleton():researchSkeleton();
    state.mounted=state.view;state.timelineSig="";state.inspectorSig="";state.researchSig="";
  }
  if(state.view==="chat")renderChat();else renderResearchView();
}

function renderKpis(){
  const host=document.querySelector("#kpis");const stats=state.summary.stats;const rsum=state.research&&state.research.summary;
  if(state.view==="research"){
    host.innerHTML=(rsum?[["Jobs",rsum.jobs],["Completed",rsum.completed],["Active",rsum.active],["Failed",rsum.failed],["Script / tool executions",rsum.scriptOrToolExecutions],["Model spend",money(rsum.modelSpendUsd)],["Lookup fee",money(rsum.lookupSpendUsd)],["Spend",money(rsum.spendUsd)]]:[["Jobs",0]]).map(([label,value])=>`<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("");return;
  }
  const success=stats.total?Math.round(100*stats.complete/stats.total):0;
  host.innerHTML=[["Active turns",stats.active],["Success",`${success}%`],["Avg duration",ms(stats.avgDurationMs)],["Grounding",bytes(stats.groundingBytes)],["Tool / skill",`${stats.toolRuns} / ${stats.skillRuns}`],["Python runs",stats.pythonRuns]].map(([label,value])=>`<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("");
}

// --- Chat turns view --------------------------------------------------------
function chatSkeleton(){return `<div class="main"><aside class="turns"><div class="pane-head"><h2>Operational turns</h2><p>Newest first · bounded retention</p></div><div id="turnList"></div></aside><main class="timeline" id="timeline"></main><aside class="inspector"><nav id="tabs" class="tabs"></nav><div id="inspectBody" class="inspect-body"></div></aside></div>`}
function renderChat(){
  document.querySelector("#turnList").innerHTML=state.turns.length?state.turns.map((turn)=>`<button class="turn ${turn.id===state.selected?"active":""}" data-turn="${esc(turn.id)}"><span class="turn-top"><span class="status ${esc(turn.status)}">${esc(turn.status)}</span><time>${esc(stamp(turn.startedAt))}</time></span><div class="question">${esc(turn.questionPreview||"No question preview")}</div><div class="turn-meta"><span>${esc(turn.runId)}</span><span>·</span><span>${esc(turn.model.split("/").pop())}</span><span>·</span><span>${esc(ms(turn.durationMs))}</span></div></button>`).join(""):`<div class="empty">No recorded turns for these filters.</div>`;
  renderTimeline();renderInspector();
}

function renderTrace(turnId,trace){
  return (Array.isArray(trace)?trace:[]).map((entry,index)=>{const key=`${turnId}:trace:${index}`;const kind=entry.label==="Reasoning"?"reasoning":"tooling";const label=entry.label==="Tool"?"Tooling":(entry.label||"Trace");return `<details class="op-trace ${kind}" data-payload-key="${esc(key)}"${state.openPayloads.has(key)?" open":""}><summary>${esc(label)}</summary><p>${esc(entry.text)}</p></details>`}).join("");
}
function renderTimeline(){
  const host=document.querySelector("#timeline");if(!host)return;if(!state.detail){host.innerHTML='<div class="empty">Run an AI Insights turn to populate operational telemetry.</div>';state.timelineSig="";return}
  const {turn,events,request,response}=state.detail;
  const sig=`${turn.id}|${events.length}|${events.map((event)=>`${event.seq}:${event.status}`).join(",")}|${request?request.id:"-"}|${response?`${response.id}:${(response.trace||[]).length}`:"-"}`;
  if(state.timelineSig===sig)return;state.timelineSig=sig;
  const reqBody=request&&request.content?esc(request.content):'<em class="muted">No request text captured.</em>';
  const resBody=response&&response.content?esc(response.content):(turn.status==="running"?'<em class="muted">Streaming…</em>':'<em class="muted">No response recorded.</em>');
  const resTraces=response&&(response.trace||[]).length?`<div class="op-traces">${renderTrace(turn.id,response.trace)}</div>`:"";
  const transcript=`<div class="transcript"><article class="bubble user"><header><span class="role">Request</span><span class="bmeta">${esc(stamp(request&&request.createdAt||turn.startedAt))}</span></header><div class="bubble-body">${reqBody}</div></article><article class="bubble assistant ${response&&response.status&&response.status!=="complete"?esc(response.status):""}"><header><span class="role">Response</span><span class="bmeta">${esc((response&&response.model)||turn.model)}</span></header><div class="bubble-body">${resBody}</div>${resTraces}</article></div>`;
  host.innerHTML=`<header class="timeline-head"><h2>${esc(turn.questionPreview)}</h2><p>${esc(turn.runId)} · ${esc(turn.conversationTitle||turn.conversationId)} · ${esc(turn.model)} · ${esc(turn.policy)}</p></header>${transcript}<div class="event-list">${events.map((event)=>{const payloadKey=`${turn.id}:${event.seq}`;return `<article class="event ${esc(event.status)}"><time class="event-time">${esc(stamp(event.occurredAt))}</time><span class="event-dot"></span><div class="event-card"><div class="event-title"><b>${esc(event.category)} · ${esc(event.name)}</b><span>#${event.seq}${event.durationMs!=null?` · ${esc(ms(event.durationMs))}`:""}</span></div>${Object.keys(event.payload||{}).length?`<details data-payload-key="${esc(payloadKey)}"${state.openPayloads.has(payloadKey)?" open":""}><summary>Structured payload</summary><pre>${esc(JSON.stringify(event.payload,null,2))}</pre></details>`:""}</div></article>`}).join("")}</div>`;
}

function findEvent(name){return state.detail?.events.find((event)=>event.name===name)}
function groundingRationale(g){
  const files=Array.isArray(g.files)?g.files:[];
  if(g.route===undefined)return "Legacy deep grounding (query-independent): packed the largest, highest-priority run artifacts up to the byte budget regardless of the question — so every turn received the same files. Restart the sidecar to pick up adaptive grounding.";
  if(g.route==="general")return `Classified as “${g.intent||"general"}” via the ${g.route} route — a conceptual, product, or definitional question. Answered from the deterministic run card only; no run files were retrieved (expected, not a failure).`;
  const fams=[...new Set(files.map((f)=>f.family).filter(Boolean))];
  return `Classified as “${g.intent||g.route}” via the ${g.route} route. Retrieved ${files.length} evidence file${files.length===1?"":"s"}${fams.length?` across ${fams.join(", ")}`:""}, ranked by schema + entity relevance within a ${g.budgetTokens||0}-token evidence budget.`;
}
function triagePointer(turnId){return `curl -s ${location.origin}/api/operations/turns/${turnId} | jq .`}
function researchTriagePointer(jobId){return `curl -s ${location.origin}/api/operations/research/${jobId} | jq .`}
async function copyToClipboard(text,button){
  let ok=true;
  try{await navigator.clipboard.writeText(text)}catch{ok=false;try{const area=document.createElement("textarea");area.value=text;area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();ok=document.execCommand("copy");area.remove()}catch{ok=false}}
  const hint=document.querySelector("#copyHint")||document.querySelector("#rCopyHint");if(hint){hint.textContent=ok?"Copied to clipboard":"Copy failed — select manually";setTimeout(()=>{if(hint)hint.textContent=""},1800)}
  if(button){const label=button.textContent;button.textContent=ok?"Copied":"Copy failed";setTimeout(()=>{button.textContent=label},1200)}
}
function renderInspector(){
  const tabs=["overview","prompt","grounding","execution","raw"];
  const tabsHost=document.querySelector("#tabs");if(!tabsHost)return;
  tabsHost.innerHTML=tabs.map((tab)=>`<button class="tab ${tab===state.tab?"active":""}" data-tab="${tab}">${tab}</button>`).join("");
  const summaryTab=state.tab==="overview"||state.tab==="execution";
  const sig=state.detail?`${state.tab}|${state.detail.turn.id}|${state.detail.events.length}|${state.detail.events.map((event)=>`${event.seq}:${event.status}`).join(",")}${summaryTab?"|"+JSON.stringify([state.summary?.runtime,state.summary?.configuration,state.summary?.stats,state.summary?.capabilities]):""}`:`${state.tab}|none`;
  if(state.inspectorSig===sig)return;state.inspectorSig=sig;
  const host=document.querySelector("#inspectBody");if(!state.detail){host.innerHTML='<div class="empty">Select a turn.</div>';return}
  const {turn,events}=state.detail;const prompt=findEvent("prompt_composed")?.payload||{};const grounding=findEvent("grounding_selected")?.payload||{};
  if(state.tab==="prompt"){
    host.innerHTML=`<section class="section"><h3>Composed prompt sent to Pi</h3><div class="callout ${prompt.captureTruncated?"fail":""}">${prompt.captureTruncated?"Prompt capture reached the 200,000-character trace limit; use the SHA-256 to correlate it with runtime logs.":"Full composed prompt captured."} Credentials and host-absolute paths are scrubbed.</div><div class="facts"><div class="fact"><span>SHA-256</span><b>${esc(prompt.sha256||"not captured")}</b></div><div class="fact"><span>Original / captured</span><b>${esc(prompt.characters||0)} / ${esc(prompt.capturedCharacters??0)}</b></div><div class="fact"><span>History restored</span><b>${esc(prompt.historyRestored||false)}</b></div><div class="fact"><span>Grounding chars</span><b>${esc(prompt.groundingCharacters||0)}</b></div></div></section><pre class="prompt">${esc(prompt.prompt||"No prompt was composed for this turn.")}</pre>`;return
  }
  if(state.tab==="grounding"){
    const g=grounding;const files=Array.isArray(g.files)?g.files:[];const adaptive=g.route!==undefined;
    const hasGrounding=adaptive||g.budgetBytes!==undefined||files.length;
    if(!hasGrounding){host.innerHTML='<section class="section"><h3>Grounding selection</h3><div class="callout">No grounding was recorded for this turn (e.g. a blocked or errored prompt).</div></section>';return}
    const facts=adaptive
      ?[["Route",g.route||"—"],["Intent",g.intent||"—"],["Candidates",g.candidateFiles||0],["Selected",files.length],["Evidence tokens",`${g.evidenceTokens||0} / ${g.budgetTokens||0}`],["Truncated",g.truncated?"yes":"no"]]
      :[["Mode","deep · legacy"],["Budget",bytes(g.budgetBytes)],["Included",bytes(g.includedBytes)],["Candidates",g.candidateFiles||0],["Selected",files.length],["Truncated",files.some((f)=>f.truncated)?"yes":"no"]];
    const rationaleClass=files.length||(adaptive&&g.route==="general")?"ok":"fail";
    const table=files.length
      ?(adaptive
        ?`<table class="ground-table"><thead><tr><th>Run-relative path · why selected</th><th>Family</th><th>Relevance</th><th>Rows</th><th>Chars</th><th>Cut</th></tr></thead><tbody>${files.map((f)=>`<tr><td>${esc(f.path)}${f.reason?`<div class="ground-why">${esc(f.reason)}</div>`:""}</td><td>${esc(f.family||"—")}</td><td>${esc(Number(f.score||0).toFixed(2))}</td><td>${esc(f.rowsReturned??"—")}</td><td>${esc(f.includedCharacters??"—")}</td><td>${f.truncated?"yes":"no"}</td></tr>`).join("")}</tbody></table>`
        :`<table class="ground-table"><thead><tr><th>Run-relative path</th><th>Kind</th><th>Included</th><th>Available</th><th>Cut</th></tr></thead><tbody>${files.map((f)=>`<tr><td>${esc(f.path)}</td><td>${esc(f.kind||"—")}</td><td>${esc(bytes(f.includedBytes))}</td><td>${esc(bytes(f.availableBytes))}</td><td>${f.truncated?"yes":"no"}</td></tr>`).join("")}</tbody></table>`)
      :'<div class="callout ok">No run files were retrieved — answered from the run card alone. Expected for general / definitional questions.</div>';
    const citations=adaptive&&Array.isArray(g.citations)&&g.citations.length
      ?`<section class="section"><h3>Row-level citations</h3><table class="ground-table"><thead><tr><th>File</th><th>Family</th><th>Rows cited</th></tr></thead><tbody>${g.citations.map((c)=>`<tr><td>${esc(c.filePath)}</td><td>${esc(c.artifactFamily||"—")}</td><td>${esc(Array.isArray(c.rowIds)?c.rowIds.slice(0,40).join(", "):"")}</td></tr>`).join("")}</tbody></table></section>`
      :"";
    host.innerHTML=`<section class="section"><h3>Grounding selection</h3><div class="callout ${rationaleClass}">${esc(groundingRationale(g))}</div><div class="facts">${facts.map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div></section><section class="section"><h3>Selected evidence</h3>${table}</section>${citations}`;return
  }
  if(state.tab==="execution"){
    const execution=events.filter((event)=>["tool","skill","python"].includes(event.category));const caps=state.summary.capabilities;
    host.innerHTML=`<section class="section"><h3>Configured versus executable</h3><div class="readiness"><div class="ready-row"><span>Python configured</span><b class="${state.summary.configuration.pythonExecution!=="disabled"?"yes":"no"}">${esc(state.summary.configuration.pythonExecution)}</b></div><div class="ready-row"><span>Python execution tool registered</span><b class="${caps.pythonExecutable?"yes":"no"}">${caps.pythonExecutable?"yes":"no"}</b></div><div class="ready-row"><span>Advertised skills</span><b>${esc(caps.advertisedSkills.length)}</b></div><div class="ready-row"><span>Pi-discovered skills</span><b class="${(caps.discoveredSkills||[]).length?"yes":""}">${esc((caps.discoveredSkills||[]).length)}</b></div><div class="ready-row"><span>Registered Pi tools</span><b class="${caps.registeredTools.length?"yes":"no"}">${esc(caps.registeredTools.join(", ")||"none")}</b></div><div class="ready-row"><span>Observed script starts</span><b>${esc(state.summary.stats.pythonRuns)}</b></div></div></section><section class="section"><h3>This turn's executions</h3>${execution.length?execution.map((event)=>`<div class="callout ${event.status==="failed"?"fail":"ok"}"><b>${esc(event.category)} · ${esc(event.name)}</b><pre>${esc(JSON.stringify(event.payload,null,2))}</pre></div>`).join(""):'<div class="callout">No tool, skill, or Python execution occurred in this turn.</div>'}</section>`;return
  }
  if(state.tab==="raw"){
    const pointer=triagePointer(turn.id);
    host.innerHTML=`<section class="section"><div class="raw-actions"><button class="btn" data-copy="json">Copy JSON</button><button class="btn" data-copy="pointer">Copy triage pointer</button><span class="copy-hint" id="copyHint"></span></div><h3>Triage pointer</h3><p class="raw-note">Paste this into an LLM (or run it) to pull this turn's full, live trace for triage.</p><pre class="pointer">${esc(pointer)}</pre><h3>Complete structured trace</h3><pre class="prompt">${esc(JSON.stringify(state.detail,null,2))}</pre></section>`;return
  }
  const stream=findEvent("sse_stream_summary")?.payload||findEvent("stream_summary")?.payload||{};
  host.innerHTML=`<section class="section"><h3>Turn outcome</h3>${turn.errorMessage?`<div class="callout fail">${esc(turn.errorMessage)}</div>`:`<div class="callout ok">${esc(turn.status)} · assistant message ${esc(turn.assistantMessageId||"not persisted")}</div>`}<div class="facts"><div class="fact"><span>Duration</span><b>${esc(ms(turn.durationMs))}</b></div><div class="fact"><span>Events</span><b>${esc(events.length)}</b></div><div class="fact"><span>Input / output</span><b>${esc(turn.inputTokens)} / ${esc(turn.outputTokens)}</b></div><div class="fact"><span>Cost</span><b>${esc(money(turn.costUsd))}</b></div><div class="fact"><span>Text deltas</span><b>${esc(stream.textDeltaCount||0)}</b></div><div class="fact"><span>Text characters</span><b>${esc(stream.textCharacters||0)}</b></div></div></section><section class="section"><h3>Runtime identity</h3><div class="readiness"><div class="ready-row"><span>Implementation</span><b>${esc(state.summary.runtime.implementation)}</b></div><div class="ready-row"><span>Warm sessions</span><b>${esc(state.summary.runtime.activeSessions)}</b></div><div class="ready-row"><span>Active turns</span><b>${esc(state.summary.runtime.activeTurns)}</b></div><div class="ready-row"><span>Retention</span><b>${esc(state.summary.configuration.retentionTurns)} turns</b></div></div></section>`;
}

// --- Deep Research jobs view (full width) -----------------------------------
function researchSkeleton(){return `<div class="rmain"><aside class="rjobs"><div class="pane-head"><h2>Deep Research jobs</h2><p>Durable, plan-approved offline execution</p></div><div id="rJobList"></div></aside><section class="rdetail" id="rDetail"></section></div>`}
function researchJobs(){return (state.research&&state.research.jobs)||[]}
function selectedResearchJob(){return researchJobs().find((job)=>job.id===state.researchSelected)||(state.researchById||{})[state.researchSelected]||null}
function renderResearchView(){
  const jobs=researchJobs();
  const list=document.querySelector("#rJobList");
  list.innerHTML=jobs.length?jobs.map((job)=>`<button class="turn ${job.id===state.researchSelected?"active":""}" data-rjob="${esc(job.id)}"><span class="turn-top"><span class="status ${esc(job.state)}">${esc(job.state)}</span><time>${esc(stamp(job.completedAt||job.startedAt||job.createdAt))}</time></span><div class="question" title="${esc(job.objective||"")}">${esc(job.title||job.objective||job.workflowId)}</div><div class="turn-meta"><span>${esc(job.workflowId)}</span><span>·</span><span>${esc(job.scriptOrToolExecutions)} executions</span><span>·</span><span>${esc(money(job.spendUsd))}</span></div></button>`).join(""):'<div class="empty">No research jobs recorded for these filters.</div>';
  renderResearchDetail();
}
function renderResearchDetail(){
  const host=document.querySelector("#rDetail");if(!host)return;
  const job=selectedResearchJob();
  if(!job){host.innerHTML='<div class="empty">Select a research job to inspect its skills, inputs, and results.</div>';state.researchSig="";return}
  const sig=`${job.id}|${job.state}|${(job.steps||[]).map((s)=>`${s.ordinal}:${s.state}`).join(",")}|${(job.events||[]).length}|${(job.conversation?.messages||[]).length}:${job.conversation?.updatedAt||""}|${state.researchTab}|${[...state.researchOpen].join(",")}|${Object.keys(state.researchOutputs).map((id)=>state.researchOutputs[id]?.open?id:"").join(",")}|cat:${Object.keys(state.researchCatalog).map((id)=>state.researchCatalog[id]?.open?`${id}:${state.researchCatalog[id].loading?"L":state.researchCatalog[id].data?"D":"E"}`:"").join(",")}`;
  if(state.researchSig===sig)return;state.researchSig=sig;
  const tabs=["overview","activity","steps","inputs","outputs","follow-ups","raw"];
  // Short editable title is the heading; the full investigation objective (often a
  // paragraph) renders as a calm, clamped sub-line — mirrors the AI Insights app.
  const rObjective=job.objective||"";const rTitle=job.title||rObjective||job.workflowId;
  const rObjectiveSub=rObjective&&rObjective!==rTitle?`<p class="rdetail-objective" title="${esc(rObjective)}">${esc(rObjective)}</p>`:"";
  host.innerHTML=`<header class="rdetail-head"><h2>${esc(rTitle)}</h2>${rObjectiveSub}<p>${esc(job.workflowId)} · ${esc(job.runId)} · <span class="status ${esc(job.state)}">${esc(job.state)}</span> · scope ${esc((job.scopeManifestHash||"—").slice(0,16))}</p></header><nav class="tabs" id="rTabs">${tabs.map((tab)=>`<button class="tab ${tab===state.researchTab?"active":""}" data-rtab="${tab}">${tab}</button>`).join("")}</nav><div class="inspect-body" id="rBody">${renderResearchTab(job)}</div>`;
}
function renderResearchTab(job){
  if(state.researchTab==="overview")return researchOverview(job);
  if(state.researchTab==="activity")return researchActivity(job);
  if(state.researchTab==="steps")return researchSteps(job);
  if(state.researchTab==="inputs")return researchInputs(job);
  if(state.researchTab==="outputs")return researchOutputsTab(job);
  if(state.researchTab==="follow-ups")return researchFollowups(job);
  return researchRaw(job);
}
function researchOverview(job){
  const plan=job.plan||{};const sources=(plan.sources||job.scope?.sources||[]);
  const facts=[["State",job.state],["Model",baseName(job.model)||"—"],["Script / tool executions",job.scriptOrToolExecutions],["Model spend",`${money(job.modelSpendUsd)} · OpenRouter-comparable`],["Lookup fee",`${money(job.lookupSpendUsd)} · internal, not billed by OpenRouter`],["Spend / cap",`${money(job.spendUsd)} / ${money(plan.maxCostUsd??job.budgetUsd)}`],["External sources",sources.length?sources.join(", "):"off"],["Scope artifacts",job.scope?job.scope.artifacts.length:"—"],["External lookups",(job.external||[]).length]];
  const provenance=job.provenanceMode==="legacy-pre-native-pi"?`<div class="callout warn">Legacy pre-migration record · ${esc(job.legacyFalseSkillRecords)} TypeScript adapter record(s); not native Pi skill executions.</div>`:`<div class="callout ok">${esc(job.state)} · native Pi activation and execution provenance</div>`;
  return `<section class="section">${job.error?`<div class="callout fail">${esc(job.error)}</div>`:provenance}<div class="facts">${facts.map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div></section>
  <section class="section"><h3>Decision objective</h3><div class="callout">${esc(plan.objective||job.objective)}</div>${(plan.limitations||[]).length?`<ul class="rlist">${plan.limitations.map((l)=>`<li>${esc(l)}</li>`).join("")}</ul>`:""}</section>
  <section class="section"><h3>Timing</h3><div class="readiness"><div class="ready-row"><span>Created</span><b>${esc(stamp(job.createdAt))}</b></div><div class="ready-row"><span>Approved</span><b>${esc(stamp(job.approvedAt))}</b></div><div class="ready-row"><span>Started</span><b>${esc(stamp(job.startedAt))}</b></div><div class="ready-row"><span>Completed</span><b>${esc(stamp(job.completedAt))}</b></div></div></section>`;
}
// Per-action timeline for the sandboxed agent. The agent_* events already
// stream into ai_research_events (and are bundled in job.events); this renders
// plan→code_run→code_result→findings with per-cell code SHA, model-turn vs
// compute timing, and cost. Structured workflows emit no agent_* events, so the
// tab explains itself and points at the Steps tab instead.
function activityCategory(short,payload){
  if(short==="jail_started"||short==="jail_stopped"||short==="netskill_started"||short==="netskill_ready")return "lifecycle";
  if(short==="code_run"||short==="netskill_egress")return "compute";
  if(short==="code_result")return (payload&&(payload.exitCode!==0||payload.timedOut))?"failed":"complete";
  if(short==="skill_run")return (payload&&(payload.exitCode!==0||payload.timedOut))?"failed":"complete";
  if(short==="skill_run_blocked"||short==="skill_run_error"||short==="netskill_failed"||short==="external_blocked")return "failed";
  if(short==="findings_emitted")return "complete";
  return "";
}
function activityLine(e,short,resultBySha){
  const p=e.payload||{};
  if(short==="jail_started")return `image <code>${esc(p.image||"—")}</code> · <code>${esc((p.imageDigest||"").slice(0,19))}…</code> · network <b>${esc(p.network||"none")}</b> · mem ${esc(p.memory||"—")} · ${esc(p.cpus||"—")} cpu · ${esc(p.pids||"—")} pids`;
  if(short==="jail_stopped")return "sandbox container torn down";
  if(short==="plan_requested")return `objective · ${esc(String(p.objective||"").slice(0,140))}`;
  if(short==="list_inputs")return `listed <b>${esc(p.count??0)}</b> frozen input(s)`;
  if(short==="skill_read")return `read skill <code>${esc(p.skillId||"—")}</code>${p.found===false?" · <b>unknown</b>":""}`;
  if(short==="model_turn")return `turn ${esc(p.turn??"—")} · model <code>${esc(baseName(p.model)||"—")}</code> · cost <b>${esc(money(p.costUsd))}</b>`;
  if(short==="model_tiers")return `running <b>${esc(baseName(p.active)||"—")}</b> · tiers — high <code>${esc(baseName(p.high)||"—")}</code> · medium <code>${esc(baseName(p.medium)||"—")}</code> · low <code>${esc(baseName(p.low)||"—")}</code>`;
  if(short==="code_run"){
    const r=resultBySha[p.codeSha];
    const dur=r?Math.max(0,new Date(r.occurredAt)-new Date(e.occurredAt)):null;
    const outcome=r?` → exit ${esc(r.payload?.exitCode)}${r.payload?.timedOut?" · <b>timed out</b>":""}${dur!=null?` · ${esc(ms(dur))} compute`:""}`:" → (no result captured)";
    return `${esc(p.label||"cell")} · sha <code>${esc(String(p.codeSha||"").slice(0,8))}</code> · ${esc(p.lines??"?")} lines · <code>${esc(p.file||"")}</code>${outcome}`;
  }
  if(short==="code_result")return `exit <b>${esc(p.exitCode)}</b>${p.timedOut?" · timed out":""} · stdout ${esc(bytes(p.stdoutBytes))} / stderr ${esc(bytes(p.stderrBytes))}`;
  if(short==="findings_emitted")return `emitted <b>${esc(p.claims??0)}</b> claim(s)`;
  if(short==="skill_run"){
    const net=p.networkPolicy==="approved-external";const t=p.timing||null;
    const tline=t?` · setup ${esc(ms(t.setupMs))} / exec ${esc(ms(t.execMs))} / egress ${esc(ms(t.egressMs))} / teardown ${esc(ms(t.teardownMs))}`:"";
    return `ran <code>${esc(p.skillId||"—")}</code> · <code>${esc(p.script||"")}</code> · ${net?`<b>network</b> (${esc(p.egress??0)} egress)`:"<b>jailed</b>"} · exit <b>${esc(p.exitCode)}</b>${p.timedOut?" · <b>timed out</b>":""} · ${esc(p.outputs??0)} output(s)${tline}`;
  }
  if(short==="skill_run_blocked")return `skill <code>${esc(p.skillId||"—")}</code> blocked · <b>${esc(p.reason||"—")}</b>`;
  if(short==="skill_run_error")return `skill <code>${esc(p.skillId||"—")}</code> rejected · ${esc(String(p.error||"").slice(0,160))}`;
  if(short==="netskill_started")return `network skill <code>${esc(p.skillId||"—")}</code> · <code>${esc(p.script||"")}</code> · egress allowlist [${esc((p.egressAllowlist||[]).join(", "))}] · image <code>${esc(p.netImage||"—")}</code> + proxy <code>${esc(p.proxyImage||"—")}</code>`;
  if(short==="netskill_ready")return `egress sandbox ready · Docker bring-up <b>${esc(ms(p.setupMs))}</b> · image <code>${esc((p.imageDigest||"").slice(0,19))}…</code>`;
  if(short==="netskill_egress"){
    const hosts=(p.hosts||[]).map((h)=>`${esc(h.host)} (${esc(h.requests)}×, ${esc(ms(h.totalMs))}${h.blocked?`, <b>${esc(h.blocked)} blocked</b>`:""})`).join(" · ");
    return `<b>${esc(p.requests??0)}</b> egress request(s) · <b>${esc(ms(p.egressMs))}</b> total${p.blocked?` · <b>${esc(p.blocked)} blocked</b>`:""}${hosts?` — ${hosts}`:""}`;
  }
  if(short==="netskill_failed")return `network skill <b>failed</b> in phase <code>${esc(p.phase||"—")}</code> · ${esc(String(p.error||"").slice(0,160))}`;
  if(short==="external_lookup")return `external <code>${esc(p.source||"—")}</code> · "${esc(p.term||"")}" · <b>${esc(p.status||"—")}</b>${p.seenInRun?" · in-run":""} · ${esc(p.citations??0)} cite(s)`;
  if(short==="external_blocked")return `external <code>${esc(p.source||"—")}</code> blocked · <b>${esc(p.error||"—")}</b>`;
  return "";
}
function researchActivity(job){
  const events=(job.events||[]).filter((e)=>String(e.name||"").startsWith("agent_"));
  if(!events.length)return '<section class="section"><div class="callout">No agentic activity recorded. Structured workflows run reviewed, pre-approved steps (see the <b>steps</b> tab); the sandboxed agent streams its plan, code cells, and findings here.</div></section>';
  const resultBySha={};
  events.forEach((e)=>{if(e.name==="agent_code_result"&&e.payload&&e.payload.codeSha)resultBySha[e.payload.codeSha]=e});
  const jailStart=events.find((e)=>e.name==="agent_jail_started");
  const modelTurns=events.filter((e)=>e.name==="agent_model_turn");
  const modelCost=modelTurns.reduce((sum,e)=>sum+Number(e.payload?.costUsd||0),0);
  const cells=events.filter((e)=>e.name==="agent_code_run");
  let computeMs=0;cells.forEach((e)=>{const r=resultBySha[e.payload?.codeSha];if(r)computeMs+=Math.max(0,new Date(r.occurredAt)-new Date(e.occurredAt))});
  const wallMs=Math.max(0,new Date(events[events.length-1].occurredAt)-new Date(events[0].occurredAt));
  const findings=events.find((e)=>e.name==="agent_findings_emitted");
  // The model the agent actually ran on: the model_tiers event records it (with
  // the high/medium/low tier set); fall back to the job's chosen model for runs
  // that predate tier observability.
  const tiersEvent=events.find((e)=>e.name==="agent_model_tiers");
  const activeModel=(tiersEvent&&tiersEvent.payload&&tiersEvent.payload.active)||job.model||"";
  const facts=[["Model",baseName(activeModel)||"—"],["Model turns",modelTurns.length],["Model cost",money(modelCost)],["Code cells",cells.length],["Compute time",ms(computeMs)],["Model time ≈",ms(Math.max(0,wallMs-computeMs))],["Wall time",ms(wallMs)],["Findings",findings?(findings.payload?.claims??0):"—"]];
  // Authoritative latency attribution from the step_timing event: provider model
  // inference vs sealed jail compute vs the network-skill runner vs our remainder.
  const timing=(events.find((e)=>e.name==="agent_step_timing")||{}).payload||null;
  const attrib=timing?[["Model time",ms(timing.modelMs)],["Jail compute",ms(timing.jailMs)],["Network skill",ms(timing.netMs||0)],["Overhead",ms(timing.overheadMs)],["Wall",ms(timing.wallMs)]]:null;
  const egressEvents=events.filter((e)=>e.name==="agent_netskill_egress");
  const ranNetSkill=events.some((e)=>e.name==="agent_netskill_started");
  const egTotalReq=egressEvents.reduce((s,e)=>s+Number(e.payload?.requests||0),0);
  const egTotalMs=egressEvents.reduce((s,e)=>s+Number(e.payload?.egressMs||0),0);
  const egBlocked=egressEvents.reduce((s,e)=>s+Number(e.payload?.blocked||0),0);
  const netFailed=events.find((e)=>e.name==="agent_netskill_failed");
  const netLine=ranNetSkill?`<div class="callout ${netFailed?"fail":"ok"}">Network skill behind the egress proxy${netFailed?` · <b>FAILED</b> in phase <code>${esc(netFailed.payload?.phase||"—")}</code>`:""} · <b>${esc(egTotalReq)}</b> proxied request(s) · <b>${esc(ms(egTotalMs))}</b> egress time${egBlocked?` · <b>${esc(egBlocked)} blocked</b>`:""}</div>`:"";
  const jailLine=jailStart
    ?`<div class="callout ok">Jailed in <b>${esc(jailStart.payload.image||"—")}</b> · digest <code>${esc((jailStart.payload.imageDigest||"").slice(0,23))}…</code> · <b>--network ${esc(jailStart.payload.network||"none")}</b> · mem ${esc(jailStart.payload.memory||"—")} · ${esc(jailStart.payload.cpus||"—")} cpu · ${esc(jailStart.payload.pids||"—")} pids</div>`
    :'<div class="callout warn">No <code>jail_started</code> event — this run predates the Docker sandbox.</div>';
  let prev=null;
  const cards=events.map((e)=>{
    const short=String(e.name).replace(/^agent_/,"");
    const delta=prev?Math.max(0,new Date(e.occurredAt)-new Date(prev.occurredAt)):null;prev=e;
    const cat=activityCategory(short,e.payload);
    const key=`act:${job.id}:${e.id}`;const open=state.researchOpen.has(key);
    const payload=e.payload&&Object.keys(e.payload).length?`<details data-ropen="${esc(key)}"${open?" open":""}><summary>payload</summary><pre class="rpre">${esc(JSON.stringify(e.payload,null,2))}</pre></details>`:"";
    return `<article class="event ${esc(cat)}"><time class="event-time">${esc(stamp(e.occurredAt))}</time><span class="event-dot"></span><div class="event-card"><div class="event-title"><b>${esc(short)}</b><span>#${esc(e.id)}${delta!=null?` · +${esc(ms(delta))}`:""}</span></div><div class="act-line">${activityLine(e,short,resultBySha)}</div>${payload}</div></article>`;
  }).join("");
  return `<section class="section">${jailLine}${netLine}${attrib?`<h3>Latency attribution</h3><div class="facts">${attrib.map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>`:""}<div class="facts">${facts.map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div></section><section class="section"><h3>Agent activity timeline</h3><div class="event-list">${cards}</div></section>`;
}
function researchSteps(job){
  return `<section class="section"><h3>Plan steps &amp; the exact implementation that ran</h3>${(job.steps||[]).map((step)=>{
    const x=step.execution;const impl=step.implementation;
    return `<div class="rcard ${esc(step.state)}"><div class="rcard-head"><b>${step.ordinal}. ${esc(step.skillId||"step")} · ${esc(step.entrypoint||"")}</b><span class="status ${esc(step.state)}">${esc(step.state)}</span></div>
    ${impl?`<div class="rkv"><span>implementation</span><code>${esc(impl.kind)} · ${esc(impl.providerImplementation)}</code></div><div class="rkv"><span>manifest</span><code>${esc(impl.manifestPath)}</code></div><div class="rkv"><span>runner</span><code>${esc(impl.runnerMethod||"—")} · rev ${esc(impl.sourceRevision||"—")}</code></div>`:""}
    <div class="rkv"><span>parameters</span><pre class="rpre">${esc(JSON.stringify(step.parameters||{},null,2))}</pre></div>
    ${x?`<div class="rkv"><span>execution</span><code>${esc(x.exitStatus)} · ${esc(ms(x.durationMs))} · seed ${esc(x.seed??"—")} · ${esc(x.inputs.length)} in / ${esc(x.outputs.length)} out · ${esc(money(x.costUsd))}</code></div>`:`<div class="rkv muted"><span>execution</span><code>not run</code></div>`}
    ${step.error?`<div class="callout fail">${esc(step.error)}</div>`:""}</div>`;
  }).join("")||'<div class="callout">No steps.</div>'}</section>`;
}
function researchInputs(job){
  if(!job.scope)return '<section class="section"><div class="callout">Inputs appear after the scope is frozen at approval.</div></section>';
  const arts=job.scope.artifacts||[];const configs=job.scope.stageConfigs||[];
  return `<section class="section"><h3>Frozen scope · ${esc(job.scope.sources?.length?`external ${job.scope.sources.join(", ")}`:"run-only")}</h3>
  <table class="ground-table"><thead><tr><th>Run-relative path</th><th>Family</th><th>Rows</th><th>Bytes</th><th>SHA-256</th><th>Pinned</th></tr></thead><tbody>${arts.map((a)=>`<tr><td>${esc(a.path)}${a.reason?`<div class="ground-why">${esc(a.reason)}</div>`:""}</td><td>${esc(a.family||"—")}</td><td>${esc(a.rowIds)}</td><td>${esc(bytes(a.bytes))}</td><td>${esc((a.sha256||"").slice(0,16))}</td><td>${a.pinned?"yes":""}</td></tr>`).join("")}</tbody></table></section>
  <section class="section"><h3>Stage configs</h3><table class="ground-table"><thead><tr><th>Path</th><th>Bytes</th><th>SHA-256</th></tr></thead><tbody>${configs.map((c)=>`<tr><td>${esc(c.path)}</td><td>${esc(bytes(c.bytes))}</td><td>${esc((c.sha256||"").slice(0,16))}</td></tr>`).join("")||'<tr><td colspan="3">—</td></tr>'}</tbody></table></section>
  ${renderCatalogSection(job)}`;
}
// The whole-run descriptive catalog: every file the agent could SEE (described in
// its prompt) and FETCH (fetch_input), vs the subset above whose bytes are
// pre-staged. Lazily fetched on expand to keep the job poll small.
function renderCatalogSection(job){
  const count=job.scope?.catalogCount||0;
  if(!count)return "";
  const staged=(job.scope?.artifacts||[]).length;
  const cat=state.researchCatalog[job.id];const open=Boolean(cat&&cat.open);
  let body="";
  if(open){
    if(cat.loading)body='<div class="callout">Loading the full catalog…</div>';
    else if(cat.error)body=`<div class="callout fail">${esc(cat.error)}</div>`;
    else if(cat.data)body=renderRunCatalog(cat.data);
  }
  // Once loaded, the header also states how many of the catalog files the agent
  // actually used in THIS run (read/cited/fetched) — the usage join.
  const usedNote=cat&&cat.data&&typeof cat.data.usedCount==="number"?` · ${cat.data.usedCount} used in this run`:"";
  return `<section class="section"><h3>Run data catalog · ${count} files${usedNote}</h3>
  <p class="raw-note">Everything this run produced and the agent could read. The ${staged} artifact${staged===1?"":"s"} above are the subset whose bytes are pre-staged into the sandbox; the rest are described to the agent and pulled on demand via <code>fetch_input</code>. The <b>Used in run</b> column shows which files the agent actually read (in its code), cited (in a claim), or fetched — vs staged-but-unused. Scope is this run's folder only — no host files, source, or other runs.</p>
  <button class="btn" data-rcatalog="${esc(job.id)}"><span class="deliverable-caret">${open?"▾":"▸"}</span> ${open?"Hide":"Show"} full catalog (${count} files)</button>${body}</section>`;
}
// Usage chips for one catalog row: green read/cited/fetched when the agent used
// the file, amber "staged · unused" for the waste signal, else muted "available".
// Degrades to "—" if the backend predates the usage join.
function catalogUsageBadges(u){
  if(!u)return '<span class="muted">—</span>';
  if(u.used)return [u.read?'<span class="status complete">read</span>':"",u.cited?'<span class="status complete">cited</span>':"",u.fetched?'<span class="status complete">fetched</span>':""].filter(Boolean).join(" ")||'<span class="status complete">used</span>';
  if(u.stagedUnused)return '<span class="status blocked">staged · unused</span>';
  return '<span class="muted">available</span>';
}
function renderRunCatalog(data){
  // Sort used files to the top, then staged-but-unused, then the available tail.
  const rank=(e)=>{const u=e.usage;if(!u)return e.staged?0:1;return u.used?0:u.stagedUnused?1:2;};
  const items=(data.catalog||[]).slice().sort((a,b)=>rank(a)-rank(b)||(Number(b.staged)-Number(a.staged))||(Number(b.canonical)-Number(a.canonical))||a.path.localeCompare(b.path));
  return `<table class="ground-table"><thead><tr><th>Run-relative path</th><th>Role</th><th>In sandbox</th><th>Used in run</th><th>Rows</th><th>What it is / how derived</th></tr></thead><tbody>${items.map((e)=>`<tr>
  <td><code>${esc(e.path)}</code> <span class="muted">${e.legacy?"legacy":"canonical"}</span></td>
  <td><code>${esc(e.role)}</code></td>
  <td>${e.staged?'<span class="status complete">staged</span>':'<span class="muted">fetch</span>'}</td>
  <td>${catalogUsageBadges(e.usage)}</td>
  <td>${e.rowCount!=null?esc(Number(e.rowCount).toLocaleString()):"—"}</td>
  <td>${esc(e.description)}<div class="ground-why">${esc(e.derivation)}</div></td></tr>`).join("")}</tbody></table>`;
}
function researchOutputsTab(job){
  const outputs=(job.steps||[]).flatMap((step)=>(step.execution?.outputs||[]).map((o)=>({...o,skillId:step.skillId})));
  const ext=job.external||[];
  const rows=outputs.map((o)=>{
    const view=o.artifactId?state.researchOutputs[o.artifactId]:null;const open=Boolean(view&&view.open);
    const intent=open&&view?.text&&String(o.path||"").toLowerCase().endsWith(".py")?generatedCodeIntent(view.text):"";
    const body=open?`<div class="rout-body">${view.loading?'<span class="muted">Loading…</span>':view.error?`<div class="callout fail">${esc(view.error)}</div>`:`${intent?`<div class="callout ok"><b>Intent</b> ${esc(intent)}</div>`:""}${renderOutputPreview(o,view.text)}`}</div>`:"";
    return `<div class="rcard ${open?"open":""}"><div class="rcard-head"><button class="rout-toggle" ${o.artifactId?`data-rout="${esc(o.artifactId)}" data-mime="${esc(o.mimeType||"")}" data-name="${esc(o.path)}"`:"disabled"}><span class="deliverable-caret">${open?"▾":"▸"}</span><b>${esc(baseName(o.path))}</b><small>${esc(o.skillId)} · ${esc(o.kind)} · ${esc(bytes(o.bytes))}${intent?` · ${esc(intent)}`:""}</small></button>${o.artifactId?`<a class="deliverable-open" href="/api/artifacts/${encodeURIComponent(o.artifactId)}/content" target="_blank" rel="noopener" title="Download">↓</a>`:""}</div><div class="rkv"><span>sha-256</span><code>${esc((o.sha256||"").slice(0,24))}</code></div>${body}</div>`;
  }).join("")||'<div class="callout">No computed outputs yet.</div>';
  const extBlock=ext.length?`<section class="section"><h3>External evidence arm</h3>${ext.map((e)=>`<div class="rcard"><div class="rcard-head"><b>${esc(e.source)} · ${esc(e.term)}</b><span class="status ${e.status==="ok"?"complete":"blocked"}">${esc(e.status)}</span></div><div class="rkv"><span>summary</span><code>${esc(e.summary||"—")}</code></div>${e.url?`<div class="rkv"><span>source</span><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a></div>`:""}</div>`).join("")}</section>`:"";
  return `<section class="section"><h3>Computed outputs (inline preview + download)</h3>${rows}</section>${extBlock}`;
}
function renderOutputPreview(output,text){
  const mime=(output.mimeType||"").toLowerCase();const name=(output.path||"").toLowerCase();
  if(mime.includes("svg")||name.endsWith(".svg"))return `<div class="rout-svg">${text}</div>`;
  if(mime.includes("html")||name.endsWith(".html"))return `<iframe class="rout-frame" src="/api/artifacts/${encodeURIComponent(output.artifactId)}/content" sandbox title="preview"></iframe>`;
  if(mime.includes("json")||name.endsWith(".json")){try{return `<pre class="rpre">${esc(JSON.stringify(JSON.parse(text),null,2))}</pre>`}catch{return `<pre class="rpre">${esc(text)}</pre>`}}
  if(mime.includes("csv")||name.endsWith(".csv")||mime.includes("tsv")||name.endsWith(".tsv")){
    const d=name.endsWith(".tsv")||mime.includes("tsv")?"\t":",";const lines=text.split(/\r?\n/).filter((l)=>l.length);
    if(!lines.length)return '<span class="muted">Empty.</span>';
    const head=lines[0].split(d);const rows=lines.slice(1,51).map((l)=>l.split(d));
    return `<div class="rtable-wrap"><table class="ground-table"><thead><tr>${head.map((c)=>`<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r)=>`<tr>${r.map((c)=>`<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${lines.length-1>50?`<p class="muted">First 50 of ${lines.length-1} rows.</p>`:""}`;
  }
  return `<pre class="rpre">${esc(text)}</pre>`;
}
// Ask / Extend follow-up turns taken on the *completed* report. They run after the
// job finishes (read-only Standard-Mode answers, or compute/external child extensions),
// emit no agent_* events, and so had no home in the other tabs — the gap that left
// these turns untraceable in the OCC. Each turn shows its policy, model, cost, the
// immutable @-references it was grounded in, and provenance receipts (prompt/output
// SHA-256). Child extensions link straight to the spawned job.
function followupTrace(m){
  const pieces=[];
  if(m.childJobId)pieces.push(`<button class="btn" data-rjob="${esc(m.childJobId)}">Open child extension job ${esc(m.childJobId)} ↗</button>`);
  const cites=m.citations||[];
  if(cites.length){const k=`fu:${m.id}:cites`;pieces.push(`<details class="op-trace tooling" data-ropen="${esc(k)}"${state.researchOpen.has(k)?" open":""}><summary>Grounded in ${cites.length} immutable reference${cites.length===1?"":"s"}</summary><table class="ground-table"><thead><tr><th>Reference</th><th>SHA-256</th><th>Selector</th></tr></thead><tbody>${cites.map((c)=>`<tr><td><code>${esc(c.ref)}</code></td><td><code>${esc(String(c.sha256||"").slice(0,16))}</code></td><td>${esc(typeof c.selector==="string"?c.selector:JSON.stringify(c.selector||[]))}</td></tr>`).join("")}</tbody></table></details>`);}
  const receipts=m.receipts||[];
  if(receipts.length){const k=`fu:${m.id}:rec`;pieces.push(`<details class="op-trace reasoning" data-ropen="${esc(k)}"${state.researchOpen.has(k)?" open":""}><summary>Provenance receipts (${receipts.length})</summary><pre class="rpre">${esc(JSON.stringify(receipts,null,2))}</pre></details>`);}
  return pieces.length?`<div class="op-traces">${pieces.join("")}</div>`:"";
}
function researchFollowups(job){
  const convo=job.conversation;const messages=(convo&&convo.messages)||[];const suggestion=convo&&convo.suggestion;
  const suggBlock=suggestion?`<section class="section"><h3>Model-suggested next question</h3><div class="callout"><b>${esc(suggestion.question||"—")}</b>${suggestion.why_now?`<div class="ground-why">${esc(suggestion.why_now)}</div>`:""}<div class="rkv"><span>model</span><code>${esc(baseName(suggestion.model)||"—")} · ${esc(money(suggestion.costUsd))}</code></div></div></section>`:"";
  if(!messages.length)return `<section class="section"><div class="callout">No follow-up turns yet. Ask / Extend turns taken on the completed report appear here — each with its policy, model, cost, the immutable references it was grounded in, and provenance receipts.</div></section>${suggBlock}`;
  const userTurns=messages.filter((m)=>m.role==="user").length;
  const spend=messages.reduce((sum,m)=>sum+Number(m.costUsd||0),0);
  const facts=[["Follow-up turns",userTurns],["Messages",messages.length],["Follow-up spend",money(spend)],["Last activity",stamp(convo.updatedAt)]];
  const bubbles=messages.map((m)=>{
    if(m.role==="user")return `<article class="bubble user"><header><span class="role">Question</span><span class="bmeta">${esc(m.runtimePolicy)} · ${esc(baseName(m.requestedModel)||"—")} · ${esc(stamp(m.createdAt))}</span></header><div class="bubble-body">${esc(m.query||m.content)}</div></article>`;
    const policy=`<span class="status ${m.runtimePolicy==="read_only"?"complete":"running"}">${esc(m.runtimePolicy)}</span>`;
    const outcome=`<span class="status ${m.outcome==="answer"?"complete":"blocked"}">${esc(m.outcome)}</span>`;
    return `<article class="bubble assistant"><header><span class="role">Answer ${policy} ${outcome}</span><span class="bmeta">${esc(baseName(m.effectiveModel)||"—")} · ${esc(money(m.costUsd))} · ${esc(stamp(m.createdAt))}</span></header><div class="bubble-body">${esc(m.content)}</div>${followupTrace(m)}</article>`;
  }).join("");
  return `<section class="section"><h3>Follow-up conversation on the completed report</h3><div class="facts">${facts.map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div></section><section class="section"><div class="transcript">${bubbles}</div></section>${suggBlock}`;
}
function researchRaw(job){
  return `<section class="section"><div class="raw-actions"><button class="btn" data-rcopy="json">Copy JSON</button><button class="btn" data-rcopy="pointer">Copy triage pointer</button><span class="copy-hint" id="rCopyHint"></span></div><h3>Triage pointer</h3><p class="raw-note">Pull this job's full live research telemetry for triage.</p><pre class="pointer">${esc(researchTriagePointer(job.id))}</pre><h3>Complete job record</h3><pre class="prompt">${esc(JSON.stringify(job,null,2))}</pre></section>`;
}
async function toggleResearchOutput(id,mime,name){
  const view=state.researchOutputs[id];
  if(view&&view.open){view.open=false;state.researchSig="";renderResearchDetail();return}
  state.researchOutputs[id]={open:true,loading:true,mime};state.researchSig="";renderResearchDetail();
  try{const response=await fetch(`/api/artifacts/${encodeURIComponent(id)}/content`);if(!response.ok)throw new Error(`Request failed (${response.status})`);state.researchOutputs[id]={open:true,loading:false,mime,text:await response.text()}}
  catch(error){state.researchOutputs[id]={open:true,loading:false,mime,error:error.message}}
  state.researchSig="";renderResearchDetail();
}
async function toggleResearchCatalog(id){
  const cur=state.researchCatalog[id];
  if(cur&&cur.open){state.researchCatalog[id]={...cur,open:false};state.researchSig="";renderResearchDetail();return}
  if(cur&&cur.data){state.researchCatalog[id]={...cur,open:true};state.researchSig="";renderResearchDetail();return}
  state.researchCatalog[id]={open:true,loading:true};state.researchSig="";renderResearchDetail();
  try{const data=await api(`/api/operations/research/${encodeURIComponent(id)}/catalog`);state.researchCatalog[id]={open:true,loading:false,data}}
  catch(error){state.researchCatalog[id]={open:true,loading:false,error:error.message}}
  state.researchSig="";renderResearchDetail();
}

const root=document.querySelector("#operations-root");root.innerHTML=shell();
root.addEventListener("click",async(event)=>{const button=event.target.closest("button");if(!button)return;
  if(button.id==="refresh")return refresh();
  if(button.dataset.view){state.view=button.dataset.view;render();return}
  if(button.dataset.copy){if(!state.detail)return;const text=button.dataset.copy==="pointer"?triagePointer(state.detail.turn.id):JSON.stringify(state.detail,null,2);return copyToClipboard(text,button)}
  if(button.dataset.rcopy){const job=selectedResearchJob();if(!job)return;const text=button.dataset.rcopy==="pointer"?researchTriagePointer(job.id):JSON.stringify(job,null,2);return copyToClipboard(text,button)}
  if(button.dataset.turn){state.selected=button.dataset.turn;state.detail=await api(`/api/operations/turns/${encodeURIComponent(state.selected)}`);state.inspectorSig="";state.timelineSig="";renderChat();return}
  if(button.dataset.tab){state.tab=button.dataset.tab;renderInspector();return}
  if(button.dataset.rjob){state.researchSelected=button.dataset.rjob;state.researchSig="";if(!researchJobs().some((j)=>j.id===state.researchSelected)&&!(state.researchById||{})[state.researchSelected])state.researchById[state.researchSelected]=await api(`/api/operations/research/${encodeURIComponent(state.researchSelected)}`).catch(()=>null);renderResearchView();return}
  if(button.dataset.rtab){state.researchTab=button.dataset.rtab;state.researchSig="";renderResearchDetail();return}
  if(button.dataset.rout){return toggleResearchOutput(button.dataset.rout,button.dataset.mime||"",button.dataset.name||"")}
  if(button.dataset.rcatalog){return toggleResearchCatalog(button.dataset.rcatalog)}
});
root.addEventListener("change",async(event)=>{if(event.target.id==="runFilter")state.runId=event.target.value;if(event.target.id==="statusFilter")state.status=event.target.value;state.selected="";await refresh()});
root.addEventListener("toggle",(event)=>{const node=event.target;if(!node||!node.dataset)return;const key=node.dataset.payloadKey;if(key){if(node.open)state.openPayloads.add(key);else state.openPayloads.delete(key);return}const rkey=node.dataset.ropen;if(rkey){if(node.open)state.researchOpen.add(rkey);else state.researchOpen.delete(rkey)}},true);
await refresh();setInterval(()=>{if(!document.hidden)void refresh()},2000);
