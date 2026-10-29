(() => {
"use strict";
const DB_NAME = "idolCollectionDB";
const DB_VERSION = 1;
const STORE = "state";
const STATE_KEY = "main";
const MAX_TICKETS = 30;
const TICKET_INTERVAL = 60 * 60 * 1000;
const RANKS = ["SR","R","N"];
const ATTRIBUTES = ["Sexy","Cool","Cute"];
const RANK_WEIGHT = {SR:10,R:30,N:60};
const BASE_CAP = {SR:50,R:40,N:30};
const XP_PER_LEVEL = 100;
const XP_PER_LIVE = 490; // Level 1 -> 50 in exactly 10 lives for an SR.
let db, state, pendingImage = null, liveSelected = new Set(), liveTapCount = 0, liveParticipants = [], currentPullSession = null, toastTimer;

const $ = id => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2));
const now = () => Date.now();
const clone = obj => JSON.parse(JSON.stringify(obj));
const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function defaultState(){ return {version:1,cards:[],tickets:30,ticketTimestamp:now(),owned:{},gachaHistory:[],liveHistory:[],lastUpdated:now()}; }
function openDB(){
 return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB_NAME,DB_VERSION);
  req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE))d.createObjectStore(STORE);};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
}
function loadState(){
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,"readonly"), req=tx.objectStore(STORE).get(STATE_KEY);
  req.onsuccess=()=>resolve(req.result || defaultState());req.onerror=()=>reject(req.error);
 });
}
function saveState(){
 state.lastUpdated=now();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,"readwrite");tx.objectStore(STORE).put(state,STATE_KEY);
  tx.oncomplete=()=>{ $("saveStatus").textContent="● 保存済み"; resolve(); };
  tx.onerror=()=>reject(tx.error);
 });
}
function toast(message){
 const el=$("toast");el.textContent=message;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2600);
}
function showModal(html){
 $("modalContent").innerHTML=html;
 const dlg=$("modal");if(!dlg.open)dlg.showModal();
}
function closeModal(){if($("modal").open)$("modal").close();}
function cap(card){return BASE_CAP[card.rank]+(card.awakening||0);}
function cardById(id){return state.cards.find(c=>c.id===id);}
function ownedCount(id){return Math.max(0,Number(state.owned[id]?.count||0));}
function ownedEntry(id){
 if(!state.owned[id])state.owned[id]={count:0,level:1,xp:0,awakening:0,liveCount:0,obtainedAt:now()};
 return state.owned[id];
}
function availableOwnedCards(){return state.cards.filter(c=>ownedCount(c.id)>0);}
function totalCopies(){return Object.values(state.owned).reduce((sum,o)=>sum+(o.count||0),0);}
function ticketTick(){
 const current=now();
 if(!Number.isFinite(state.ticketTimestamp))state.ticketTimestamp=current;
 if(state.tickets>=MAX_TICKETS){state.tickets=MAX_TICKETS;state.ticketTimestamp=current;return false;}
 const elapsed=current-state.ticketTimestamp;
 const recovered=Math.floor(elapsed/TICKET_INTERVAL);
 if(recovered>0){
  state.tickets=Math.min(MAX_TICKETS,state.tickets+recovered);
  state.ticketTimestamp = state.tickets>=MAX_TICKETS ? current : state.ticketTimestamp+recovered*TICKET_INTERVAL;
  return true;
 }
 return false;
}
function nextTicketText(){
 if(state.tickets>=MAX_TICKETS)return "チケットは満タンです";
 const remaining=Math.max(0,TICKET_INTERVAL-(now()-state.ticketTimestamp)%TICKET_INTERVAL);
 const minutes=Math.floor(remaining/60000), seconds=Math.floor((remaining%60000)/1000);
 return `次の1枚まで ${String(minutes).padStart(2,"0")}分 ${String(seconds).padStart(2,"0")}秒`;
}
function updateTicketsUI(){
 $("ticketCount").textContent=state.tickets;$("gachaTicketCount").textContent=state.tickets;
 $("ticketBar").style.width=`${state.tickets/MAX_TICKETS*100}%`;
 $("ticketRecovery").textContent=nextTicketText();
 $("singlePull").disabled=state.tickets<1;$("tenPull").disabled=state.tickets<10;
}
function goTo(page){
 document.querySelectorAll(".page").forEach(el=>el.classList.toggle("active",el.id==="page-"+page));
 document.querySelectorAll(".nav-item").forEach(el=>el.classList.toggle("active",el.dataset.nav===page));
 if(page==="home")updateTicketsUI();
 if(page==="encyclopedia")renderEncyclopedia();
 if(page==="live")renderLiveSetup();
 if(page==="register")renderRegisterStats();
 window.scrollTo({top:0,behavior:"smooth"});
}
function rankClass(rank){return `rank-${rank}`;}
function imageDataURL(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});}
async function optimizeImage(file){
 if(!file.type.startsWith("image/"))throw new Error("画像ファイルを選択してください。");
 const data=await imageDataURL(file);
 const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error("画像を読み込めませんでした。"));i.src=data;});
 const max=1200, ratio=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
 const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(img.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(img.naturalHeight*ratio));
 const ctx=canvas.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
 return canvas.toDataURL("image/jpeg",.86);
}
function imageOrSilhouette(card, className=""){
 if(card.image)return `<img class="${className}" src="${card.image}" alt="${escapeHTML(card.name)}">`;
 return `<div class="silhouette ${className}" aria-label="画像なし">?</div>`;
}
function renderRegisterStats(){
 $("registerCatalogCount").textContent=state.cards.length;
 $("ownedCopiesCount").textContent=totalCopies();
}
function renderEncyclopedia(){
 const q=$("searchCards").value.trim().toLocaleLowerCase("ja");
 const rank=$("filterRank").value, attr=$("filterAttribute").value, sort=$("sortCards").value;
 let cards=state.cards.filter(c=>(!q||c.name.toLocaleLowerCase("ja").includes(q))&&(!rank||c.rank===rank)&&(!attr||c.attribute===attr));
 const rankIndex={SR:0,R:1,N:2}, attrIndex={Sexy:0,Cool:1,Cute:2};
 cards.sort((a,b)=>{
  let v=0;
  if(sort.startsWith("rank"))v=rankIndex[a.rank]-rankIndex[b.rank];
  else if(sort.startsWith("name"))v=a.name.localeCompare(b.name,"ja");
  else if(sort.startsWith("attribute"))v=attrIndex[a.attribute]-attrIndex[b.attribute];
  else if(sort.startsWith("level"))v=(state.owned[a.id]?.level||0)-(state.owned[b.id]?.level||0);
  if(sort.endsWith("desc"))v=-v;
  return v||a.name.localeCompare(b.name,"ja");
 });
 $("catalogCount").textContent=state.cards.length;
 $("collectionSummary").textContent=`${cards.length} 件表示 ／ 所持 ${cards.filter(c=>ownedCount(c.id)>0).length} 種`;
 const grid=$("cardGrid");
 if(!cards.length){grid.innerHTML=`<div class="empty-state">${state.cards.length?"条件に合うカードがありません。":"カードがまだ登録されていません。登録画面から写真を追加してください。"}</div>`;return;}
 grid.innerHTML=cards.map(c=>{
  const n=ownedCount(c.id), o=state.owned[c.id]||{};
  const media=n? (c.image?`<img class="idol-image" src="${c.image}" alt="${escapeHTML(c.name)}">`:`<div class="silhouette"></div>`) : `<div class="silhouette"></div>`;
  return `<article class="idol-card ${rankClass(c.rank)} ${n?"":"not-owned"}" data-card-id="${c.id}">
    <div style="position:relative">${media}<span class="rank-label">${c.rank}</span><span class="owned-label">${n?`所持 ×${n}`:"未所持"}</span><div class="rank-frame"></div></div>
    <div class="idol-info"><div class="idol-name">${escapeHTML(c.name)}</div><div class="idol-meta"><span class="attr-${c.attribute}">${c.attribute}</span><span>${n?`Lv.${o.level} ★${o.awakening||0}`:"未獲得"}</span></div></div>
  </article>`;
 }).join("");
 grid.querySelectorAll("[data-card-id]").forEach(el=>el.addEventListener("click",()=>openCardDetail(el.dataset.cardId)));
}
function openCardDetail(id){
 const card=cardById(id);if(!card)return;
 const count=ownedCount(id), o=state.owned[id];
 const media=card.image?`<img class="detail-image" src="${card.image}" alt="${escapeHTML(card.name)}">`:`<div class="detail-image silhouette">?</div>`;
 const ownedFacts=count?`<div class="fact"><small>レベル</small><strong>Lv.${o.level} / ${cap({...card,awakening:o.awakening||0})}</strong></div><div class="fact"><small>覚醒数</small><strong>${o.awakening||0} / 10</strong></div><div class="fact"><small>経験値</small><strong>${o.xp||0} / ${XP_PER_LEVEL}</strong></div><div class="fact"><small>所持枚数</small><strong>${count} 枚</strong></div>`:`<div class="fact"><small>所持状況</small><strong>未所持</strong></div>`;
 showModal(`<div class="modal-card-detail">${media}<div><span class="eyebrow">CARD DETAIL</span><h2>${escapeHTML(card.name)}</h2><p class="muted tiny">${card.rank} ／ ${card.attribute}</p><div class="detail-facts">${ownedFacts}</div><div class="detail-actions"><button class="secondary-button" id="detailEdit">編集</button><button class="secondary-button" id="detailDelete">登録削除</button>${count?`<button class="primary-button" id="detailAwaken">覚醒</button><button class="danger-button" id="detailDismiss">解雇</button>`:""}</div></div></div><p class="muted tiny" style="margin:16px 0 0">登録削除はカード定義と関連する所持データを削除します。解雇は所持分のみを削除し、図鑑の登録情報は残します。</p>`);
 $("detailEdit").onclick=()=>{closeModal();beginEdit(id);goTo("register");};
 $("detailDelete").onclick=()=>confirmDeleteCard(id);
 if(count){$("detailAwaken").onclick=()=>{closeModal();openAwaken(id);};$("detailDismiss").onclick=()=>confirmDismiss(id);}
}
function resetForm(){
 $("cardForm").reset();$("editCardId").value="";pendingImage=null;
 $("imagePreview").innerHTML="＋";$("uploadTitle").textContent="写真を選択";
 $("formTitle").textContent="新しいカードを登録";$("saveCardBtn").textContent="カードを登録";$("cancelEditBtn").classList.add("hidden");
}
function beginEdit(id){
 const c=cardById(id);if(!c)return;
 $("editCardId").value=id;$("cardName").value=c.name;$("cardAttribute").value=c.attribute;$("cardRank").value=c.rank;
 pendingImage=c.image||null;
 $("imagePreview").innerHTML=c.image?`<img src="${c.image}" alt="">`:"＋";
 $("uploadTitle").textContent="画像を変更する場合はタップ";
 $("formTitle").textContent="カード情報を編集";$("saveCardBtn").textContent="変更を保存";$("cancelEditBtn").classList.remove("hidden");
}
function confirmDeleteCard(id){
 const c=cardById(id);if(!c)return;
 showModal(`<span class="eyebrow">DELETE CARD</span><h2>登録カードを削除しますか？</h2><p>${escapeHTML(c.name)}（${c.rank}）の登録情報と所持枚数・育成データが削除されます。この操作は元に戻せません。</p><div class="detail-actions"><button class="secondary-button" id="cancelDelete">キャンセル</button><button class="danger-button" id="confirmDelete">削除する</button></div>`);
 $("cancelDelete").onclick=closeModal;
 $("confirmDelete").onclick=async()=>{state.cards=state.cards.filter(x=>x.id!==id);delete state.owned[id];await saveState();closeModal();renderEncyclopedia();renderRegisterStats();toast("登録カードを削除しました。");};
}
function confirmDismiss(id){
 const c=cardById(id), n=ownedCount(id);if(!c||!n)return;
 showModal(`<span class="eyebrow">DISMISS IDOL</span><h2>このカードを解雇しますか？</h2><p><b>${escapeHTML(c.name)}</b> の所持分（${n}枚）をすべて削除します。図鑑の登録情報は残ります。所持分のレベル・経験値・覚醒状況も失われます。</p><div class="detail-actions"><button class="secondary-button" id="cancelDismiss">キャンセル</button><button class="danger-button" id="confirmDismissBtn">解雇する</button></div>`);
 $("cancelDismiss").onclick=closeModal;
 $("confirmDismissBtn").onclick=async()=>{delete state.owned[id];await saveState();closeModal();renderEncyclopedia();renderLiveSetup();renderRegisterStats();toast("解雇しました。図鑑の登録情報は残っています。");};
}
function openAwaken(id){
 const c=cardById(id),o=state.owned[id];if(!c||!o)return;
 const max=o.awakening>=10, dup=o.count>=2;
 showModal(`<span class="eyebrow">AWAKENING</span><h2>${escapeHTML(c.name)}を覚醒</h2><p>同じ登録カードの重複分を1枚消費します。現在のレベルは維持され、レベル上限が1上がります。</p><div class="detail-facts"><div class="fact"><small>現在のレベル</small><strong>Lv.${o.level}</strong></div><div class="fact"><small>現在の上限</small><strong>Lv.${cap({...c,awakening:o.awakening||0})}</strong></div><div class="fact"><small>覚醒回数</small><strong>${o.awakening||0} / 10</strong></div><div class="fact"><small>所持枚数</small><strong>${o.count} 枚</strong></div></div>${max?`<p class="warning-text">覚醒上限の10回に達しています。</p>`:!dup?`<p class="warning-text">覚醒には同じ登録カードが2枚以上必要です。</p>`:`<p class="muted tiny">覚醒後：レベル上限 ${cap({...c,awakening:o.awakening||0})} → ${cap({...c,awakening:(o.awakening||0)+1})}</p>`}<div class="detail-actions"><button class="secondary-button" id="cancelAwaken">戻る</button><button class="primary-button" id="confirmAwaken" ${max||!dup?"disabled":""}>1枚消費して覚醒</button></div>`);
 $("cancelAwaken").onclick=closeModal;
 $("confirmAwaken").onclick=async()=>{if(o.awakening>=10||o.count<2)return;o.count--;o.awakening++;o.xp=Math.min(o.xp||0,XP_PER_LEVEL-1);await saveState();closeModal();renderEncyclopedia();toast(`覚醒しました！ レベル上限が${cap({...c,awakening:o.awakening})}になりました。`);};
}
function renderLiveSetup(){
 const roster=$("liveRoster");const cards=availableOwnedCards();
 liveSelected=new Set([...liveSelected].filter(id=>cards.some(c=>c.id===id)));
 $("selectedCount").textContent=`${liveSelected.size} / 10`;
 $("startLive").disabled=liveSelected.size<1;
 if(!cards.length){roster.innerHTML='<div class="empty-state">所持カードがありません。先に登録してガチャを引いてください。</div>';return;}
 roster.innerHTML=cards.map(c=>{
  const o=state.owned[c.id],selected=liveSelected.has(c.id);
  return `<button class="roster-option ${selected?"selected":""}" data-roster-id="${c.id}">${c.image?`<img src="${c.image}" alt="">`:'<span class="roster-placeholder">✦</span>'}<span style="min-width:0"><strong>${escapeHTML(c.name)}</strong><small>${c.rank} · Lv.${o.level} · ×${o.count}</small></span>${selected?'<span class="check-mark">✓</span>':""}</button>`;
 }).join("");
 roster.querySelectorAll("[data-roster-id]").forEach(el=>el.onclick=()=>{
  const id=el.dataset.rosterId;
  if(liveSelected.has(id))liveSelected.delete(id);
  else if(liveSelected.size>=10){toast("ライブ参加は最大10人です。");return;}
  else liveSelected.add(id);
  renderLiveSetup();
 });
}
function startLive(){
 if(!liveSelected.size)return;
 liveParticipants=[...liveSelected].map(id=>({id,card:cardById(id),entry:clone(state.owned[id])})).filter(x=>x.card&&x.entry.count>0);
 if(!liveParticipants.length){toast("参加できる所持カードがありません。");return;}
 liveTapCount=0;$("liveSetup").classList.add("hidden");$("liveResult").classList.add("hidden");$("livePlaying").classList.remove("hidden");
 $("tapCount").textContent="0";$("liveProgressBar").style.width="0%";
 $("livePerformerNames").innerHTML=liveParticipants.map(x=>`<span class="performer-chip">${escapeHTML(x.card.name)}</span>`).join("");
 $("cheerEffects").innerHTML="";
}
function cheer(){
 if(liveTapCount>=50)return;
 liveTapCount++;$("tapCount").textContent=liveTapCount;$("liveProgressBar").style.width=`${liveTapCount*2}%`;
 const symbols=["✦","✧","♥","♪","✺"];const pop=document.createElement("span");pop.className="cheer-pop";pop.textContent=symbols[Math.floor(Math.random()*symbols.length)];pop.style.left=`${8+Math.random()*84}%`;pop.style.top=`${35+Math.random()*50}%`;pop.style.color=["#f0abfc","#c4b5fd","#93c5fd","#f9a8d4"][Math.floor(Math.random()*4)];$("cheerEffects").appendChild(pop);setTimeout(()=>pop.remove(),800);
 if(liveTapCount>=50){$("cheerButton").disabled=true;$("cheerButton").innerHTML="<span>✦</span><b>LIVE COMPLETE!</b>";setTimeout(completeLive,500);}
}
async function completeLive(){
 const results=[];
 for(const p of liveParticipants){
  const card=cardById(p.id);let o=state.owned[p.id];if(!card||!o||o.count<1)continue;
  const beforeLevel=o.level, beforeCap=cap({...card,awakening:o.awakening||0});
  let gained=0;
  if(o.level<beforeCap){
   gained=XP_PER_LIVE;
   let xp=(o.xp||0)+gained;
   while(o.level<beforeCap&&xp>=XP_PER_LEVEL){xp-=XP_PER_LEVEL;o.level++;}
   if(o.level>=beforeCap){xp=0;gained=XP_PER_LIVE;}
   o.xp=xp;
  }
  o.liveCount=(o.liveCount||0)+1;
  results.push({id:p.id,name:card.name,rank:card.rank,image:card.image,levelBefore:beforeLevel,levelAfter:o.level,xpGained:gained,levelUp:o.level>beforeLevel,level: o.level,cap:beforeCap});
 }
 state.liveHistory.unshift({at:now(),participants:results.map(r=>r.id),taps:50});
 state.liveHistory=state.liveHistory.slice(0,200);
 await saveState();
 $("livePlaying").classList.add("hidden");
 $("liveResult").classList.remove("hidden");
 $("liveResult").innerHTML=`<span class="eyebrow">LIVE RESULT</span><h2>ライブ終了！ おつかれさま。</h2><p class="muted">参加キャラ全員に同じ固定経験値を付与しました。レベル上限中のキャラは経験値を獲得しません。</p>${results.map(r=>`<div class="result-participant">${r.image?`<img src="${r.image}" alt="">`:'<span class="result-avatar">✦</span>'}<div><strong>${escapeHTML(r.name)} ${r.levelUp?'<span class="level-up">LEVEL UP!</span>':""}</strong><small>${r.rank} · Lv.${r.levelBefore} → Lv.${r.levelAfter} · ${r.xpGained?`+${r.xpGained} EXP`:"経験値獲得なし（上限）"}</small></div></div>`).join("")}<button id="againLive" class="primary-button wide-button" style="margin-top:16px">もう一度ライブ</button>`;
 $("againLive").onclick=()=>{ $("liveResult").classList.add("hidden");$("liveSetup").classList.remove("hidden");liveSelected.clear();renderLiveSetup();};
 liveSelected.clear();renderLiveSetup();renderEncyclopedia();renderRegisterStats();toast("ライブ結果を保存しました。");
}
function weightedRank(){
 const registered=new Set(state.cards.map(c=>c.rank));
 const available=RANKS.filter(r=>registered.has(r));
 if(!available.length)return null;
 const total=available.reduce((s,r)=>s+RANK_WEIGHT[r],0);
 let n=Math.random()*total;
 for(const r of available){n-=RANK_WEIGHT[r];if(n<0)return r;}
 return available[available.length-1];
}
function drawCard(){
 const rank=weightedRank();if(!rank)return null;
 const eligible=state.cards.filter(c=>c.rank===rank);
 return eligible[Math.floor(Math.random()*eligible.length)];
}
function addCopy(card){
 const o=ownedEntry(card.id);o.count++;if(!o.obtainedAt)o.obtainedAt=now();
}
async function pull(count){
 if(state.cards.length===0){toast("先に登録画面でカードを登録してください。");goTo("register");return;}
 if(state.tickets<count){toast(`チケットが${count}枚必要です。`);return;}
 state.tickets-=count;
 if(state.tickets<MAX_TICKETS && state.ticketTimestamp>now())state.ticketTimestamp=now();
 const results=[];
 for(let i=0;i<count;i++){
  const card=drawCard();if(!card)break;addCopy(card);results.push({id:card.id,name:card.name,rank:card.rank,attribute:card.attribute,image:card.image});
 }
 state.gachaHistory.unshift({at:now(),count,results:results.map(r=>r.id)});
 state.gachaHistory=state.gachaHistory.slice(0,300);
 currentPullSession={results,index:0,count};
 await saveState();updateTicketsUI();renderRegisterStats();renderEncyclopedia();renderRecentPulls();
 if(count===1)showSingleReveal();else showTenReveal();
}
function showSingleReveal(){
 const r=currentPullSession.results[0];if(!r){toast("登録カードが見つかりませんでした。");return;}
 showModal(`<div class="pull-reveal"><span class="eyebrow">NEW ACQUISITION</span><h2>カードを獲得！</h2>${r.image?`<img src="${r.image}" alt="">`:'<div class="detail-image silhouette" style="width:200px;margin:auto">✦</div>'}<div class="rank-big rank-${r.rank}">${r.rank}</div><h3>${escapeHTML(r.name)}</h3><p class="muted">${r.attribute} ／ 所持 ×${ownedCount(r.id)}</p><div class="pull-controls"><button id="revealClose" class="primary-button">OK</button><button id="revealDetail" class="secondary-button">カード詳細</button></div></div>`);
 $("revealClose").onclick=closeModal;$("revealDetail").onclick=()=>{closeModal();openCardDetail(r.id);};
}
function showTenReveal(){
 currentPullSession.index=0;showCurrentTenCard();
}
function showCurrentTenCard(){
 const s=currentPullSession;if(!s)return;
 const r=s.results[s.index];if(!r){showTenSummary();return;}
 showModal(`<div class="pull-reveal"><span class="eyebrow">10 PULL · ${s.index+1} / ${s.results.length}</span><h2>カードを獲得！</h2>${r.image?`<img src="${r.image}" alt="">`:'<div class="detail-image silhouette" style="width:200px;margin:auto">✦</div>'}<div class="rank-big rank-${r.rank}">${r.rank}</div><h3>${escapeHTML(r.name)}</h3><p class="muted">${r.attribute} ／ 所持 ×${ownedCount(r.id)}</p><div class="pull-controls"><button id="nextPullCard" class="primary-button">${s.index===s.results.length-1?"結果一覧へ":"次のカードへ"}</button></div></div>`);
 $("nextPullCard").onclick=()=>{s.index++;if(s.index>=s.results.length)showTenSummary();else showCurrentTenCard();};
}
function showTenSummary(){
 const results=currentPullSession.results;
 const counts={SR:0,R:0,N:0};results.forEach(r=>counts[r.rank]++);
 showModal(`<span class="eyebrow">10 PULL SUMMARY</span><h2>10連ガチャ結果</h2><p class="muted">SR ${counts.SR} 枚 ／ R ${counts.R} 枚 ／ N ${counts.N} 枚</p><div class="pull-result-grid">${results.map(r=>`<div class="pull-card rank-${r.rank}">${r.image?`<img src="${r.image}" alt="">`:'<div class="silhouette"></div>'}<div class="pull-name">${r.rank} · ${escapeHTML(r.name)}</div></div>`).join("")}</div><button id="summaryClose" class="primary-button wide-button">閉じる</button>`);
 $("summaryClose").onclick=closeModal;
}
function renderRecentPulls(){
 const el=$("recentPulls"),history=state.gachaHistory.slice(0,1)[0];
 if(!history||!history.results.length){el.className="card-strip empty-note";el.textContent="まだガチャの結果がありません。";return;}
 const cards=history.results.map(id=>cardById(id)).filter(Boolean);
 el.className="card-strip";el.innerHTML=cards.map(c=>`<div class="pull-card ${rankClass(c.rank)}">${c.image?`<img src="${c.image}" alt="">`:'<div class="silhouette"></div>'}<div class="pull-name">${c.rank} · ${escapeHTML(c.name)}</div></div>`).join("");
}
async function exportBackup(){
 try{
  const payload={format:"idol-collection-backup",version:1,exportedAt:new Date().toISOString(),state};
  const blob=new Blob([JSON.stringify(payload)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`idol-collection-backup-${new Date().toISOString().slice(0,10)}.idolbackup`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  toast("バックアップを書き出しました。");
 }catch(e){console.error(e);toast("バックアップに失敗しました。空き容量を確認してください。");}
}
async function importBackup(file){
 if(!file)return;
 try{
  const raw=JSON.parse(await file.text());
  if(raw.format!=="idol-collection-backup"||!raw.state||!Array.isArray(raw.state.cards))throw new Error("形式が正しくありません。");
  const accepted=confirm("バックアップを復元しますか？\n現在のデータはバックアップの内容に置き換わります。\n復元前に必要なら現在のデータをバックアップしてください。");
  if(!accepted)return;
  const incoming=raw.state;
  incoming.tickets=Math.max(0,Math.min(MAX_TICKETS,Number(incoming.tickets)||0));
  incoming.ticketTimestamp=Number(incoming.ticketTimestamp)||now();
  incoming.owned=incoming.owned||{};incoming.gachaHistory=incoming.gachaHistory||[];incoming.liveHistory=incoming.liveHistory||[];
  state=incoming;ticketTick();await saveState();renderAll();$("settingsModal").close();toast("バックアップを復元しました。");
 }catch(e){console.error(e);alert("復元できませんでした。正しいバックアップファイルか確認してください。\n"+e.message);}
}
async function clearAllData(){
 if(!confirm("すべての登録カード・画像・所持データを削除しますか？\nこの操作は元に戻せません。バックアップをおすすめします。"))return;
 state=defaultState();await saveState();renderAll();$("settingsModal").close();toast("すべてのデータを削除しました。");
}
function renderAll(){
 updateTicketsUI();renderEncyclopedia();renderLiveSetup();renderRecentPulls();renderRegisterStats();
}
function bindEvents(){
 document.querySelectorAll("[data-nav]").forEach(el=>el.addEventListener("click",()=>goTo(el.dataset.nav)));
 $("settingsBtn").onclick=()=>$("settingsModal").showModal();
 document.querySelectorAll("[data-close-settings]").forEach(el=>el.onclick=()=>$("settingsModal").close());
 $("exportBtn").onclick=exportBackup;
 $("importFile").onchange=e=>{importBackup(e.target.files[0]);e.target.value="";};
 $("clearDataBtn").onclick=clearAllData;
 $("singlePull").onclick=()=>pull(1);$("tenPull").onclick=()=>pull(10);
 $("searchCards").oninput=renderEncyclopedia;$("filterRank").onchange=renderEncyclopedia;$("filterAttribute").onchange=renderEncyclopedia;$("sortCards").onchange=renderEncyclopedia;
 $("cardImage").onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try{pendingImage=await optimizeImage(file);$("imagePreview").innerHTML=`<img src="${pendingImage}" alt="">`;$("uploadTitle").textContent="画像を選択済み";}catch(err){toast(err.message||"画像を読み込めませんでした。");}
 };
 $("cardForm").onsubmit=async e=>{
  e.preventDefault();
  const name=$("cardName").value.trim();if(!name){toast("カード名を入力してください。");return;}
  if(!pendingImage){const existing=cardById($("editCardId").value);if(!existing){toast("カード画像を選択してください。");return;}pendingImage=existing.image;}
  const id=$("editCardId").value;
  if(id){
   const card=cardById(id);if(!card)return;
   card.name=name;card.attribute=$("cardAttribute").value;card.rank=$("cardRank").value;card.image=pendingImage;
   toast("カード情報を更新しました。");
  }else{
   state.cards.push({id:uid(),name,attribute:$("cardAttribute").value,rank:$("cardRank").value,image:pendingImage,registeredAt:now()});
   toast("カードを登録しました。");
  }
  await saveState();resetForm();renderAll();goTo("encyclopedia");
 };
 $("cancelEditBtn").onclick=resetForm;
 $("startLive").onclick=startLive;$("cheerButton").onclick=cheer;
 $("modal").addEventListener("click",e=>{if(e.target===$("modal"))closeModal();});
}
function startClock(){setInterval(async()=>{if(ticketTick()){await saveState();}updateTicketsUI();},1000);}
async function init(){
 try{db=await openDB();state=await loadState();if(!state.cards)state=defaultState();ticketTick();await saveState();bindEvents();renderAll();startClock();
  if("serviceWorker" in navigator && (location.protocol==="https:"||location.hostname==="localhost"))navigator.serviceWorker.register("./sw.js").catch(()=>{});
 }catch(e){console.error(e);alert("アプリの保存領域を開けませんでした。Safariのプライベートブラウズではなく通常のブラウズでお試しください。");}
}
init();
})();