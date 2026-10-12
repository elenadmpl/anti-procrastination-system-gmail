/* Orbit: private local workspace. No mail sending or remote AI calls. */
'use strict';
const C=OrbitCore, $=id=>document.getElementById(id), e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state,db,activeView='board',tool='select',selected=new Set(),history=[],future=[],drag=null,space=false,connectFrom=null,photoPending=null,photoContact=null,qrStream=null,qrFrame=null,worker=null,focusList=[],focusIndex=0,timerRemaining=0,timerEnd=0,timerPaused=false,timerInterval=null,saveTimer=null,saveQueue=Promise.resolve(),dirty=false;
const palette=['yellow','lavender','mint','peach','blue','white'];
const board=()=>state.boards.find(b=>b.id===state.activeBoard)||state.boards[0];
const camera=()=>board().camera;
const nodes=()=>state.nodes.filter(n=>n.board===state.activeBoard);
const contact=id=>state.contacts.find(c=>c.id===id);
const node=id=>state.nodes.find(n=>n.id===id);
function toast(text){$('toast').textContent=text;$('toast').classList.add('show');clearTimeout(toast.timeout);toast.timeout=setTimeout(()=>$('toast').classList.remove('show'),3800);}
function requestDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('orbit-workspace',1);r.onupgradeneeded=()=>{r.result.createObjectStore('state');r.result.createObjectStore('photos');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function read(store,key){return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function write(store,key,value){return new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value,key);t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}
function checkpoint(){history.push(structuredClone(state));if(history.length>40)history.shift();future=[];}
function persist(){
 dirty=true;$('save-status').textContent='Saving…';clearTimeout(saveTimer);
 saveTimer=setTimeout(()=>{const snapshot=structuredClone(state);saveQueue=saveQueue.catch(()=>{}).then(()=>write('state','workspace',snapshot)).then(()=>{dirty=false;$('save-status').textContent='Saved on this device';}).catch(err=>{$('save-status').textContent='Not saved — export a backup';toast('Could not save. Please export a private backup.');console.error(err);});},180);
}
function change(fn,rerender=true){checkpoint();fn();persist();if(rerender)render();}
function undo(){if(!history.length)return;future.push(structuredClone(state));state=history.pop();selected.clear();persist();render();toast('Undone');}
function redo(){if(!future.length)return;history.push(structuredClone(state));state=future.pop();selected.clear();persist();render();}
function applyCamera(){const {x,y,z}=camera();$('world').style.transform='translate('+x+'px,'+y+'px) scale('+z+')';$('zoom-label').textContent=Math.round(z*100)+'%';}
function worldPoint(clientX,clientY){const r=$('viewport').getBoundingClientRect(),c=camera();return {x:(clientX-r.left-c.x)/c.z,y:(clientY-r.top-c.y)/c.z};}
function centerPoint(){const r=$('viewport').getBoundingClientRect();return worldPoint(r.left+r.width/2,r.top+r.height/2);}
function zoom(factor,cx,cy){const r=$('viewport').getBoundingClientRect();cx=cx??r.left+r.width/2;cy=cy??r.top+r.height/2;const p=worldPoint(cx,cy),c=camera();c.z=Math.max(.15,Math.min(2.5,c.z*factor));c.x=cx-r.left-p.x*c.z;c.y=cy-r.top-p.y*c.z;applyCamera();persist();}
function fit(){
 const ns=nodes();if(!ns.length)return;const minx=Math.min(...ns.map(n=>n.x)),miny=Math.min(...ns.map(n=>n.y-40)),maxx=Math.max(...ns.map(n=>n.x+n.w)),maxy=Math.max(...ns.map(n=>n.y+n.h));const r=$('viewport').getBoundingClientRect(),c=camera();
 c.z=Math.max(.15,Math.min(1,(r.width-160)/(maxx-minx),(r.height-100)/(maxy-miny)));c.x=80-minx*c.z+(r.width-160-(maxx-minx)*c.z)/2;c.y=50-miny*c.z;applyCamera();persist();
}
function setTool(t){tool=t;connectFrom=null;document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));$('viewport').style.cursor=t==='hand'?'grab':t==='select'?'default':'crosshair';}
function renderNav(){
 $('boards').innerHTML=state.boards.map(b=>'<button class="nav-item '+(activeView==='board'&&b.id===state.activeBoard?'active':'')+'" data-board="'+e(b.id)+'"><span>'+(b.id==='network'?'◌':b.id==='followups'?'↗':b.id==='today'?'☀':'▢')+'</span>'+e(b.name)+'</button>').join('');
 $('people-count').textContent=state.contacts.length;$('people-nav').classList.toggle('active',activeView==='people');$('journal-nav').classList.toggle('active',activeView==='journal');$('xp').textContent=state.xp+' little win'+(state.xp===1?'':'s');
 $('crumb').textContent=activeView==='board'?board().name:activeView==='people'?'People':'Journal';$('board-title').textContent=activeView==='board'?board().subtitle:activeView==='people'?'Your people, in one place':'A little space to think';
 $('board-caption').textContent=activeView==='board'?(state.activeBoard==='followups'?'Keep the promises. Close the open loops.':state.activeBoard==='today'?'Choose less. Finish something that matters.':'A place for the people you want to keep in your orbit.'):activeView==='people'?'Real conversations. Useful context. One next step.':'Notes, ideas and reflections — just for you.';
}
function render(){
 renderNav();$('viewport').hidden=activeView!=='board';$('list-view').hidden=activeView!=='people';$('journal-view').hidden=activeView!=='journal';
 if(activeView==='board')renderCanvas();else if(activeView==='people')renderPeople();else renderJournal();
 renderInspector();
}
function cardContent(n){
 const c=contact(n.contactId);if(n.type==='frame')return '<h3>'+e(n.title||'Frame')+'</h3><span class="resize-handle">◢</span>';
 if(n.type==='drawing')return '<svg width="100%" height="100%" viewBox="0 0 '+n.w+' '+n.h+'"><polyline points="'+e(n.points.map(p=>p.x+','+p.y).join(' '))+'" fill="none" stroke="#8976bb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
 if(n.type==='person'&&c)return '<div class="card-top"><span class="initials">'+e(c.name.split(' ').slice(0,2).map(x=>x[0]).join(''))+'</span><span class="status">'+e(c.status)+'</span></div><h3>'+e(c.name)+'</h3><div class="company">'+e(c.company)+'</div><div class="memo">'+e(c.memo)+'</div><div class="foot"><span>'+e(c.event||'Connection')+'</span><span><i class="priority-dot '+e(c.priority)+'"></i>'+e(c.due||c.priority)+'</span></div><span class="resize-handle">◢</span>';
 return (n.type==='task'?'<button class="task-check" data-check="'+n.id+'" aria-label="'+(n.done?'Reopen task':'Complete task')+'">'+(n.done?'✓':'')+'</button>':'')+'<h3>'+e(n.title||'New note')+'</h3><div class="memo">'+e(n.body||'Double-click to write something.')+'</div><span class="resize-handle">◢</span>';
}
function renderCanvas(){
 const ns=nodes().slice().sort((a,b)=>(a.type==='frame'?0:1)-(b.type==='frame'?0:1));
 $('nodes').innerHTML=ns.map(n=>'<div tabindex="0" role="button" aria-label="'+e(n.type==='person'?contact(n.contactId)?.name:n.title||n.type)+'" class="node '+e(n.type)+' '+e(n.color||'white')+(selected.has(n.id)?' selected':'')+(n.done?' done':'')+'" data-node="'+e(n.id)+'" style="left:'+n.x+'px;top:'+n.y+'px;width:'+n.w+'px;height:'+n.h+'px">'+cardContent(n)+'</div>').join('');
 $('empty-board').hidden=ns.length>0;applyCamera();renderEdges();
}
function renderEdges(){
 const svg=$('edges'),local=state.edges.filter(l=>node(l.from)?.board===state.activeBoard&&node(l.to)?.board===state.activeBoard);
 svg.innerHTML='<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9" fill="#b6a8d0"/></marker></defs>'+local.map(l=>{const a=node(l.from),b=node(l.to);return '<line x1="'+(10000+a.x+a.w/2)+'" y1="'+(10000+a.y+a.h/2)+'" x2="'+(10000+b.x+b.w/2)+'" y2="'+(10000+b.y+b.h/2)+'" stroke="#b6a8d0" stroke-width="2" marker-end="url(#arrow)"/>';}).join('');
}
function selectNode(id,multi=false){if(!multi)selected.clear();if(multi&&selected.has(id))selected.delete(id);else selected.add(id);document.querySelectorAll('[data-node]').forEach(el=>el.classList.toggle('selected',selected.has(el.dataset.node)));renderInspector();}
function addNode(type,p){
 if(type==='person'){openCapture();return;}
 change(()=>{const n={id:C.uid(),board:state.activeBoard,type,x:p.x,y:p.y,w:type==='frame'?420:280,h:type==='frame'?600:220,title:type==='task'?'One next step':type==='frame'?'New frame':'A fresh thought',body:'',color:type==='frame'?'lavender':type==='task'?'mint':'yellow',done:false};state.nodes.push(n);selected=new Set([n.id]);});setTool('select');
}
function field(label,id,value,type='text'){return '<label>'+label+'<input id="'+id+'" type="'+type+'" value="'+e(value||'')+'"></label>';}
function renderInspector(){
 const n=selected.size===1?node([...selected][0]):null;
 if(!n){$('inspector').hidden=true;return;}
 $('inspector').hidden=false;
 const c=contact(n.contactId);let body='<div class="panel-heading"><h2>'+(c?'Person & next step':n.type==='task'?'Your next step':'Edit '+n.type)+'</h2><button id="close-inspector" class="circle" aria-label="Close details">×</button></div>';
 if(c){
 body+=field('Name','edit-name',c.name)+field('Company','edit-company',c.company)+field('Role','edit-role',c.role)+field('Email','edit-email',c.email)+field('LinkedIn profile','edit-linkedin',c.linkedin,'url')+field('Where you met','edit-event',c.event);
 body+='<label>Conversation notes<textarea id="edit-memo" rows="4">'+e(c.memo)+'</textarea></label>'+field('One next step','edit-action',c.nextAction)+field('Next touch date','edit-due',c.due,'date');
 body+='<div class="two-col"><label>Priority<select id="edit-priority">'+['Urgent','High','Medium','Low'].map(p=>'<option '+(p===c.priority?'selected':'')+'>'+p+'</option>').join('')+'</select></label><label>Status<select id="edit-status">'+['To follow up','Waiting','Handled','Parked'].map(p=>'<option '+(p===c.status?'selected':'')+'>'+p+'</option>').join('')+'</select></label></div>';
 body+='<p class="muted">'+e(c.source||'Manual capture')+(c.lastReceived?'<br>Last received: '+e(c.lastReceived):'')+(c.lastSent?'<br>Last sent: '+e(c.lastSent):'')+'</p><div id="contact-photo"></div>';
 body+='<div class="inspector-actions"><button id="attach-badge">＋ Badge photo</button><button id="add-task-contact">＋ Linked task</button></div><div class="draft-label">Suggested draft · review before sending</div><textarea id="edit-draft" class="draft-edit">'+e(C.draftFor(c))+'</textarea><div class="inspector-actions"><button id="copy-draft" class="primary">Copy draft</button><button id="open-gmail">Open Gmail</button><button id="open-linkedin">Open LinkedIn</button></div><button id="mark-handled" class="subtle full">✓ Mark handled on this board</button>';
 }else if(n.type!=='drawing'){
 body+=field('Title','edit-title',n.title)+'<label>Note<textarea id="edit-body" rows="6">'+e(n.body||'')+'</textarea></label>';
 if(n.type==='task')body+=field('Due date','edit-task-due',n.due,'date')+'<label class="inline"><input type="checkbox" id="edit-done" '+(n.done?'checked':'')+'> Completed</label>';
 }
 body+='<label>Card color<select id="edit-color">'+palette.map(p=>'<option '+(p===n.color?'selected':'')+'>'+p+'</option>').join('')+'</select></label><div class="inspector-actions"><button id="save-card" class="primary">Save changes</button><button id="remove-card" class="danger">Remove from board</button></div><small class="muted">Removing a card keeps its person in the database.</small>';
 $('inspector').innerHTML=body;
 $('close-inspector').onclick=()=>{selected.clear();renderCanvas();$('inspector').hidden=true;};
 $('save-card').onclick=()=>{saveInspector(n,c);toast('Saved');};
 $('remove-card').onclick=()=>{change(()=>{state.nodes=state.nodes.filter(x=>!selected.has(x.id));state.edges=state.edges.filter(l=>!selected.has(l.from)&&!selected.has(l.to));selected.clear();});};
 if(c){
 $('copy-draft').onclick=()=>copy($('edit-draft').value);
 $('open-gmail').onclick=()=>openGmail(c);
 $('open-linkedin').onclick=()=>openURL(c.linkedin,'Add a LinkedIn profile URL first.');
 $('mark-handled').onclick=()=>{saveInspector(n,c);handleContact(c.id);};
 $('attach-badge').onclick=()=>{photoContact=c.id;$('photo-file').click();};
 $('add-task-contact').onclick=()=>{saveInspector(n,c);change(()=>state.nodes.push({id:C.uid(),board:'today',type:'task',contactId:c.id,x:360,y:30+state.nodes.filter(x=>x.board==='today'&&x.type==='task').length*245,w:310,h:210,title:c.nextAction?c.nextAction.slice(0,65):'Follow up with '+c.name,body:c.name+' · '+c.company,color:'mint',done:false}));toast('Linked task added to Today');};
 if(c.photoId)read('photos',c.photoId).then(p=>{if(p&&$('contact-photo'))$('contact-photo').innerHTML='<img class="photo-thumb" alt="Saved conference badge" src="'+e(p.data)+'">';});
 }
}
function saveInspector(n,c){
 change(()=>{
 if(c){const map={name:'name',company:'company',role:'role',email:'email',linkedin:'linkedin',event:'event',memo:'memo',action:'nextAction',due:'due',priority:'priority',status:'status',draft:'draft'};for(const [id,key] of Object.entries(map))c[key]=$('edit-'+id).value.trim();if(!c.name)c.name='Contact';}
 else {if($('edit-title'))n.title=$('edit-title').value;if($('edit-body'))n.body=$('edit-body').value;if($('edit-task-due'))n.due=$('edit-task-due').value;if($('edit-done'))n.done=$('edit-done').checked;}
 n.color=$('edit-color').value;
 });
}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('Draft copied. Review it before sending.');}catch{toast('Clipboard unavailable. Select the draft and copy it manually.');}}
function openURL(s,msg){const u=C.safeURL(s);if(u)window.open(u,'_blank','noopener');else toast(msg||'Add a valid link first.');}
function openGmail(c){
 if(c.gmail){openURL(c.gmail);return;}
 const email=c.email.split(/[;,]/).map(s=>s.trim()).filter(Boolean).join(',');
 if(!email){toast('Add an email address first.');return;}
 const u='https://mail.google.com/mail/u/0/?view=cm&fs=1&to='+encodeURIComponent(email)+'&su='+encodeURIComponent(c.subject||('Following up'+(c.event?' after '+c.event:'')));
 openURL(u);
}
function celebrate(){
 $('buddy-message').textContent='You closed a loop. Nice work.';$('buddy').classList.add('celebrate');setTimeout(()=>$('buddy').classList.remove('celebrate'),1400);
 for(let i=0;i<7;i++){const p=document.createElement('span');p.className='confetti';p.textContent=['✧','·','♡'][i%3];p.style.left=10+Math.random()*80+'%';p.style.top='30%';p.style.color=['#7965dc','#e4c073','#9bccb2'][i%3];document.body.append(p);setTimeout(()=>p.remove(),1100);}
}
function handleContact(id){
 change(()=>{const c=contact(id);c.status='Handled';c.handledAt=new Date().toISOString();if(!c.rewarded){c.rewarded=true;state.xp++;}});celebrate();toast('Marked handled on your board. No email sent.');
}
function completeTask(id){
 const n=node(id);change(()=>{n.done=!n.done;if(n.done&&!n.rewarded){state.xp++;n.rewarded=true;}});if(n.done)celebrate();
}
function showView(view){activeView=view;selected.clear();render();}
function renderPeople(){
 const oldQ=$('people-search')?.value||'',oldFilter=$('people-filter')?.value||'';
 $('list-view').innerHTML='<div class="list-top"><input type="search" id="people-search" placeholder="Search people, company or conversation…" aria-label="Search database" value="'+e(oldQ)+'"><select id="people-filter" aria-label="Filter people"><option value="">All statuses</option>'+['To follow up','Waiting','Handled','Parked'].map(s=>'<option '+(s===oldFilter?'selected':'')+'>'+s+'</option>').join('')+'</select><button id="people-add" class="primary">＋ Quick capture</button></div><div id="people-results"></div>';
 $('people-add').onclick=()=>openCapture();$('people-search').oninput=filterPeople;$('people-filter').onchange=filterPeople;filterPeople();
}
function filterPeople(){
 const q=$('people-search').value.toLowerCase(),f=$('people-filter').value;
 const cs=state.contacts.filter(c=>(!f||c.status===f)&&[c.name,c.company,c.memo,c.event,c.role,c.email].join(' ').toLowerCase().includes(q));
 $('people-results').innerHTML=cs.length?'<table class="people-table"><thead><tr><th>PERSON</th><th>STATUS / NEXT TOUCH</th><th>NEXT STEP</th></tr></thead><tbody>'+cs.map(c=>'<tr data-contact="'+e(c.id)+'"><td><strong>'+e(c.name)+'</strong><small>'+e(c.company)+'</small></td><td>'+e(c.status)+'<small><br>'+e(c.due||c.priority)+'</small></td><td>'+e((c.nextAction||'Add a next step').slice(0,110))+'</td></tr>').join('')+'</tbody></table>':'<p class="muted">No people here yet. Add a note, import your contacts, or capture a Gmail thread.</p>';
 $('people-results').onclick=ev=>{const row=ev.target.closest('[data-contact]');if(!row)return;let n=state.nodes.find(n=>n.contactId===row.dataset.contact);if(!n){change(()=>{n={id:C.uid(),board:'network',type:'person',contactId:row.dataset.contact,x:120,y:120,w:295,h:202,color:'lavender'};state.nodes.push(n);},false);}selected=new Set([n.id]);renderInspector();};
}
function renderJournal(){
 $('journal-view').innerHTML='<div class="journal-compose"><span class="eyebrow">'+e(C.today())+' · YOUR JOURNAL</span><h2>What’s on your mind?</h2><input id="journal-title" placeholder="A title, if you like" aria-label="Journal title"><textarea id="journal-body" placeholder="A thought, a conference memory, the thing you’re avoiding…"></textarea><button id="journal-save" class="primary">Save entry</button></div>'+state.journal.slice().reverse().map(j=>'<article class="journal-entry"><div class="journal-actions"><button data-pin="'+e(j.id)+'">Pin to board</button><button data-edit-journal="'+e(j.id)+'">Edit</button></div><small>'+e(j.date)+'</small><h3>'+e(j.title||'A note to myself')+'</h3><p>'+e(j.body)+'</p></article>').join('');
 $('journal-save').onclick=()=>{const text=$('journal-body').value.trim();if(!text){toast('Write a little something first.');return;}change(()=>state.journal.push({id:C.uid(),date:C.today(),title:$('journal-title').value,body:text}));toast('Journal entry saved');};
 $('journal-view').onclick=ev=>{const pin=ev.target.closest('[data-pin]'),edit=ev.target.closest('[data-edit-journal]');if(pin){const j=state.journal.find(x=>x.id===pin.dataset.pin);change(()=>state.nodes.push({id:C.uid(),board:state.activeBoard,type:'sticky',x:120,y:130,w:310,h:260,title:j.title||j.date,body:j.body,color:'yellow'}));toast('Pinned to '+board().name);}if(edit){const j=state.journal.find(x=>x.id===edit.dataset.editJournal);$('journal-title').value=j.title;$('journal-body').value=j.body;$('journal-save').textContent='Save edited entry';$('journal-save').onclick=()=>{change(()=>{j.title=$('journal-title').value;j.body=$('journal-body').value;});toast('Entry updated');};$('journal-view').scrollTop=0;}};
}
function openCapture(preset={}){
 photoContact=null;photoPending=null;$('capture-form').reset();$('badge-preview').innerHTML='';$('capture-status').textContent='';
 for(const [k,v] of Object.entries(preset)){const el=$('cap-'+k);if(el)el.value=v;}
 $('capture-dialog').showModal();
}
$('parse-capture').onclick=()=>{const p=C.parseCapture($('capture-text').value);for(const [k,v] of Object.entries(p))if(v&&$('cap-'+k))$('cap-'+k).value=v;toast('Check the fields before saving');};
$('capture-form').onsubmit=async ev=>{
 ev.preventDefault();const name=$('cap-name').value.trim();if(!name)return;
 const c={id:C.uid(),name,company:$('cap-company').value.trim(),role:$('cap-role').value.trim(),email:$('cap-email').value.trim(),linkedin:$('cap-linkedin').value.trim(),event:$('cap-event').value.trim(),memo:$('cap-memo').value.trim(),nextAction:$('cap-action').value.trim(),due:$('cap-due').value,priority:'Medium',status:'To follow up',source:photoPending?'Badge photo · fields confirmed manually':'Quick capture',created:new Date().toISOString()};
 const previous=state.contacts.find(x=>C.samePerson(x,c));let cid=previous?.id||c.id;
 try{if(photoPending){c.photoId=C.uid();await write('photos',c.photoId,photoPending);}}
 catch{toast('Photo could not be saved. Please try again.');return;}
 change(()=>{if(previous){for(const key of ['company','role','email','linkedin','event'])if(!previous[key]&&c[key])previous[key]=c[key];if(c.memo)previous.memo=[previous.memo,c.memo].filter(Boolean).join('\n\n');if(c.nextAction)previous.nextAction=c.nextAction;if(c.due)previous.due=c.due;if(c.photoId)previous.photoId=c.photoId;}else state.contacts.push(c);
 if(!state.nodes.some(n=>n.board===state.activeBoard&&n.contactId===cid)){const p=centerPoint();state.nodes.push({id:C.uid(),board:state.activeBoard,type:'person',contactId:cid,x:p.x-145,y:p.y-100,w:295,h:202,color:'lavender'});}
 });
 const useTimer=$('cap-timer').checked;$('capture-dialog').close();toast(previous?'Existing person updated':'Person saved');if(useTimer){openFocus(cid);startTimer(300);}
};
async function resizePhoto(file){
 if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Error('Please choose JPG, PNG or WebP. Export HEIC from Photos as JPG first.');
 if(file.size>20*1024*1024)throw Error('Choose a photo smaller than 20 MB.');
 const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
 const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('This photo could not be opened.'));i.src=data;});
 const z=Math.min(1,2200/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.round(img.width*z);canvas.height=Math.round(img.height*z);canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);return {name:file.name,data:canvas.toDataURL('image/jpeg',.9)};
}
$('photo-file').onchange=async ev=>{
 const f=ev.target.files[0];ev.target.value='';if(!f)return;
 try{
 const photo=await resizePhoto(f);
 if(photoContact){const cid=photoContact,pid=C.uid();await write('photos',pid,photo);change(()=>contact(cid).photoId=pid);toast('Badge attached to the person');photoContact=null;return;}
 if(!$('capture-dialog').open)openCapture();
 photoPending=photo;$('badge-preview').innerHTML='<img class="photo-thumb" alt="Badge to review" src="'+e(photo.data)+'">';
 $('capture-status').textContent='Reading the badge on your device…';
 if(!worker)worker=await Tesseract.createWorker('eng',1,{workerPath:new URL('vendor/worker.min.js',location.href).href,corePath:new URL('vendor/tesseract-core-lstm.wasm.js',location.href).href,langPath:new URL('vendor/lang/',location.href).href,workerBlobURL:false,logger:m=>{if(m.status==='recognizing text')$('capture-status').textContent='Reading badge… '+Math.round((m.progress||0)*100)+'%';}});
 const result=await worker.recognize(photo.data),text=result.data.text;
 $('capture-text').value=text;const p=C.parseCapture(text),lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(p.name)$('cap-name').value=p.name;if(p.email)$('cap-email').value=p.email;if(p.linkedin)$('cap-linkedin').value=p.linkedin;$('cap-company').value=p.company||(lines[1]&&!/@|https?:/.test(lines[1])?lines[1]:'');$('cap-role').value=p.role||(lines[2]&&!/@|https?:/.test(lines[2])?lines[2]:'');
 $('capture-status').textContent='Text read ('+Math.round(result.data.confidence)+'% OCR confidence). Confirm the name, company and role; badges can be misread.';
 }catch(err){$('capture-status').textContent=err.message+' You can enter the details manually.';toast(err.message);}
};
function photoCapture(){if($('connections-dialog').open)$('connections-dialog').close();openCapture();$('photo-file').click();}
$('badge-upload').onclick=()=>{photoContact=null;$('photo-file').click();};$('badge-import').onclick=photoCapture;
$('csv-file').onchange=async ev=>{
 const file=ev.target.files[0];ev.target.value='';if(!file)return;
 try{const incoming=C.linkedInCSV(await file.text()),result=C.mergeContacts(state.contacts,incoming);change(()=>state.contacts=result.contacts);$('connection-status').textContent=result.added+' people added; '+result.matched+' existing people matched. Open People to choose who goes on the board.';toast('LinkedIn contacts imported');}catch(err){toast(err.message);}
};
function validBackup(d){
 if(d.version!==1||!Array.isArray(d.boards)||!d.boards.length||!Array.isArray(d.nodes)||!Array.isArray(d.contacts)||!Array.isArray(d.edges)||!Array.isArray(d.journal))throw Error('This is not a valid Orbit backup.');
 const ids=new Set();for(const n of d.nodes){if(typeof n.id!=='string'||ids.has(n.id)||![n.x,n.y,n.w,n.h].every(Number.isFinite)||n.w<=0||n.h<=0||!['person','task','sticky','frame','drawing'].includes(n.type))throw Error('The backup contains an invalid board card.');ids.add(n.id);}
 for(const b of d.boards)if(!b.id||!b.camera||![b.camera.x,b.camera.y,b.camera.z].every(Number.isFinite)||b.camera.z<.1||b.camera.z>3)throw Error('The backup contains an invalid board.');
 for(const c of d.contacts)if(typeof c.id!=='string'||typeof c.name!=='string')throw Error('The backup contains an invalid contact.');
 for(const p of d.photos||[])if(typeof p.id!=='string'||!/^data:image\/(jpeg|png|webp);base64,/.test(p.data||''))throw Error('The backup contains an invalid photo.');
 if(!d.boards.some(b=>b.id===d.activeBoard))d.activeBoard=d.boards[0].id;
 d.xp=Number(d.xp)||0;d.focusMinutes=Number(d.focusMinutes)||0;return d;
}
$('json-file').onchange=async ev=>{
 const file=ev.target.files[0];ev.target.value='';if(!file)return;
 try{
 const d=JSON.parse(await file.text());
 if(d.items){const result=C.reviewImport(d,state);change(()=>state=result.state);toast(result.count+' reviewed follow-ups imported');}
 else{
 validBackup(d);if(!confirm('Restore this backup? It replaces the current board, contacts and journal. Export your current backup first if you need to keep it.'))return;
 for(const p of d.photos||[])await write('photos',p.id,{name:p.name,data:p.data});delete d.photos;change(()=>state=d);activeView='board';render();toast('Backup restored');
 }
 $('connection-status').textContent='Import complete.';
 }catch(err){toast(err.message);}
};
async function exportBackup(){
 try{
 const photos=[];for(const c of state.contacts.filter(c=>c.photoId)){const p=await read('photos',c.photoId);if(p&&!photos.some(x=>x.id===c.photoId))photos.push({id:c.photoId,...p});}
 const blob=new Blob([JSON.stringify({...state,photos},null,2)],{type:'application/json'});download(blob,'orbit-private-backup-'+C.today()+'.json');toast('Private backup exported');
 }catch{toast('Backup could not be exported. Please try again.');}
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function pullGmail(){
 if(!globalThis.chrome?.storage?.local){$('connection-status').textContent='For Gmail capture, load the extension folder in Chrome → Extensions → Developer mode → Load unpacked. Open Orbit from the extension toolbar. This browser preview can import review JSON and backups.';return;}
 const {orbitCaptures=[]}=await chrome.storage.local.get('orbitCaptures');let count=0;
 change(()=>{state.captureIds=state.captureIds||[];for(const r of orbitCaptures){if(state.captureIds.includes(r.id))continue;let c=state.contacts.find(x=>x.email&&x.email===r.email);if(!c){c={id:C.uid(),name:r.name||r.email||'Gmail contact',email:r.email||'',company:'',role:'',linkedin:'',event:'',memo:r.context||'',nextAction:'Inspect the thread and decide the next step',status:'To follow up',priority:'Medium',due:'',source:'Gmail capture · reply status not verified',gmail:r.url,subject:r.subject,captureId:r.id,created:r.created};state.contacts.push(c);}else{c.gmail=r.url;c.subject=r.subject;c.memo=[c.memo,r.context].filter(Boolean).join('\n\n');c.captureId=r.id;}state.captureIds.push(r.id);
 const pos=state.nodes.filter(n=>n.board==='followups'&&n.type==='person').length;state.nodes.push({id:C.uid(),board:'followups',type:'person',contactId:c.id,x:1550,y:60+pos%15*228,w:295,h:202,color:'blue'});count++;}});
 $('connection-status').textContent=count?'Imported '+count+' captured thread(s). Review the original conversation to set reply status.':'No new captured threads. In Gmail, open a conversation and click Save thread to Orbit.';
}
function openFocus(id){
 focusList=state.contacts.filter(c=>c.status!=='Handled'&&c.status!=='Parked').sort((a,b)=>['Urgent','High','Medium','Low'].indexOf(a.priority)-['Urgent','High','Medium','Low'].indexOf(b.priority));
 if(id){focusList=focusList.filter(c=>c.id!==id);focusList.unshift(contact(id));}
 focusIndex=0;renderFocus();$('focus-dialog').showModal();
}
function renderFocus(){
 const c=focusList[focusIndex];$('focus-position').textContent=c?(focusIndex+1)+' / '+focusList.length+' people':'All clear for now';
 $('focus-done').disabled=!c;$('focus-skip').disabled=!c;
 if(!c){$('focus-content').innerHTML='<h3>You made room.</h3><p>Take a breath, add a new connection, or return to your board.</p>';stopTimer();return;}
 $('focus-content').innerHTML='<h3>'+e(c.name)+'</h3><p>'+e(c.company)+' · '+e(c.priority)+' · '+e(c.status)+'</p><p class="focus-context">'+e(c.nextAction||c.memo)+'</p><textarea id="focus-draft" aria-label="Editable suggested draft">'+e(C.draftFor(c))+'</textarea><div class="inspector-actions"><button id="focus-copy" class="primary">Copy draft</button><button id="focus-save-draft">Save draft</button><button id="focus-gmail">Open Gmail</button><button id="focus-linkedin">Open LinkedIn</button></div>';
 $('focus-copy').onclick=()=>copy($('focus-draft').value);$('focus-save-draft').onclick=()=>{change(()=>contact(c.id).draft=$('focus-draft').value,false);toast('Draft saved on your board');};
 $('focus-gmail').onclick=()=>openGmail(c);$('focus-linkedin').onclick=()=>openURL(c.linkedin,'Add the person’s LinkedIn profile first.');
}
function stopTimer(){clearInterval(timerInterval);timerRemaining=0;timerEnd=0;$('focus-time').textContent='Ready';}
function startTimer(seconds){clearInterval(timerInterval);timerRemaining=seconds;timerEnd=Date.now()+seconds*1000;timerPaused=false;$('timer-pause').textContent='Pause';tickTimer();timerInterval=setInterval(tickTimer,250);}
function tickTimer(){
 if(timerPaused)return;
 timerRemaining=Math.max(0,Math.ceil((timerEnd-Date.now())/1000));
 $('focus-time').textContent=Math.floor(timerRemaining/60)+':'+String(timerRemaining%60).padStart(2,'0');
 if(!timerRemaining){clearInterval(timerInterval);$('buddy-message').textContent='Time to breathe. Your draft is still here.';toast('Time is up. You can continue at your own pace.');}
}
$('focus-skip').onclick=()=>{focusIndex++;renderFocus();};$('focus-done').onclick=()=>{const c=focusList[focusIndex];if(!c)return;handleContact(c.id);focusIndex++;renderFocus();};
$('timer-60').onclick=()=>startTimer(60);$('timer-300').onclick=()=>startTimer(300);$('timer-1500').onclick=()=>startTimer(1500);$('timer-pause').onclick=()=>{if(!timerRemaining)return;timerPaused=!timerPaused;if(!timerPaused)timerEnd=Date.now()+timerRemaining*1000;$('timer-pause').textContent=timerPaused?'Resume':'Pause';};
async function startQR(){
 if(!globalThis.BarcodeDetector){$('capture-status').textContent='QR scanning is not supported in this browser. Paste the LinkedIn profile URL instead.';return;}
 try{
 const formats=await BarcodeDetector.getSupportedFormats();if(!formats.includes('qr_code'))throw Error('QR scanning is not supported. Paste the profile URL instead.');
 const detector=new BarcodeDetector({formats:['qr_code']});qrStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});$('qr-video').srcObject=qrStream;$('qr-dialog').showModal();
 async function loop(){if(!$('qr-dialog').open)return;try{if($('qr-video').readyState>=2){const codes=await detector.detect($('qr-video'));const found=codes.find(c=>/^https:\/\/(?:www\.)?linkedin\.com\/in\//i.test(c.rawValue));if(found){$('cap-linkedin').value=found.rawValue;$('qr-dialog').close();return;}}}catch{}qrFrame=setTimeout(loop,200);}loop();
 }catch(err){$('capture-status').textContent=err.message||'Camera unavailable. Paste a LinkedIn URL instead.';stopQR();}
}
function stopQR(){if(qrStream)qrStream.getTracks().forEach(t=>t.stop());qrStream=null;clearTimeout(qrFrame);}
$('scan-qr').onclick=startQR;$('qr-dialog').addEventListener('close',stopQR);$('qr-dialog').addEventListener('cancel',stopQR);
$('focus-dialog').addEventListener('close',stopTimer);
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('boards').onclick=ev=>{const b=ev.target.closest('[data-board]');if(b){state.activeBoard=b.dataset.board;showView('board');persist();}};
$('new-board').onclick=()=>{const name=prompt('Name your new board');if(!name?.trim())return;change(()=>{const id=C.uid();state.boards.push({id,name:name.trim(),subtitle:name.trim(),camera:{x:100,y:100,z:1}});state.activeBoard=id;});showView('board');};
$('people-nav').onclick=()=>showView('people');$('journal-nav').onclick=()=>showView('journal');$('capture-nav').onclick=()=>openCapture();$('add-person').onclick=()=>openCapture();$('import-nav').onclick=()=>$('connections-dialog').showModal();$('help').onclick=()=>$('help-dialog').showModal();$('search-toggle').onclick=()=>{showView('people');$('people-search').focus();};
$('linkedin-import').onclick=()=>$('csv-file').click();$('review-import').onclick=()=>$('json-file').click();$('pull-gmail').onclick=pullGmail;$('backup').onclick=exportBackup;$('focus-open').onclick=()=>openFocus();$('undo').onclick=undo;$('redo').onclick=redo;
$('zoom-in').onclick=()=>zoom(1.2);$('zoom-out').onclick=()=>zoom(1/1.2);$('fit').onclick=fit;$('home-view').onclick=()=>{board().camera={x:90,y:90,z:.9};applyCamera();persist();};
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
$('viewport').addEventListener('wheel',ev=>{if(ev.target.closest('.zoom-tools,.floating-tools'))return;ev.preventDefault();if(ev.ctrlKey||ev.metaKey)zoom(Math.exp(-ev.deltaY*.002),ev.clientX,ev.clientY);else{camera().x-=ev.deltaX;camera().y-=ev.deltaY;applyCamera();persist();}},{passive:false});
$('viewport').addEventListener('pointerdown',ev=>{
 if(ev.button!==0&&ev.button!==1)return;if(ev.target.closest('.floating-tools,.zoom-tools'))return;
 const el=ev.target.closest('[data-node]'),n=el?node(el.dataset.node):null,p=worldPoint(ev.clientX,ev.clientY);
 if(ev.target.closest('[data-check]')){completeTask(n.id);return;}
 if(tool==='hand'||space||ev.button===1){drag={kind:'pan',sx:ev.clientX,sy:ev.clientY,x:camera().x,y:camera().y};}
 else if(n&&tool==='connect'){if(!connectFrom){connectFrom=n.id;selectNode(n.id);toast('Choose the second card');}else if(connectFrom!==n.id){const from=connectFrom;change(()=>state.edges.push({id:C.uid(),from,to:n.id}));connectFrom=null;setTool('select');}return;}
 else if(tool==='pen'){checkpoint();const newNode={id:C.uid(),board:state.activeBoard,type:'drawing',x:p.x,y:p.y,w:1,h:1,points:[{x:0,y:0}],color:'white'};state.nodes.push(newNode);drag={kind:'draw',id:newNode.id,points:[p]};selected.clear();}
 else if(['sticky','task','frame','person'].includes(tool)){addNode(tool,p);return;}
 else if(n){if(!selected.has(n.id)||ev.shiftKey)selectNode(n.id,ev.shiftKey);checkpoint();drag={kind:ev.target.closest('.resize-handle')?'resize':'move',sx:p.x,sy:p.y,items:[...selected].map(id=>{const x=node(id);return {id,x:x.x,y:x.y,w:x.w,h:x.h};})};}
 else{selected.clear();renderCanvas();renderInspector();return;}
 ev.preventDefault();(el&&drag?.kind!=='pan'?el:$('viewport')).setPointerCapture(ev.pointerId);
});
$('viewport').addEventListener('pointermove',ev=>{
 if(!drag)return;const p=worldPoint(ev.clientX,ev.clientY);
 if(drag.kind==='pan'){camera().x=drag.x+ev.clientX-drag.sx;camera().y=drag.y+ev.clientY-drag.sy;applyCamera();return;}
 if(drag.kind==='draw'){drag.points.push(p);const n=node(drag.id),xs=drag.points.map(p=>p.x),ys=drag.points.map(p=>p.y);n.x=Math.min(...xs);n.y=Math.min(...ys);n.w=Math.max(1,Math.max(...xs)-n.x);n.h=Math.max(1,Math.max(...ys)-n.y);n.points=drag.points.map(p=>({x:p.x-n.x,y:p.y-n.y}));renderCanvas();return;}
 for(const start of drag.items){const n=node(start.id);if(drag.kind==='resize'){n.w=Math.max(160,start.w+p.x-drag.sx);n.h=Math.max(100,start.h+p.y-drag.sy);}else{n.x=start.x+p.x-drag.sx;n.y=start.y+p.y-drag.sy;}const el=document.querySelector('[data-node="'+n.id+'"]');if(el){el.style.left=n.x+'px';el.style.top=n.y+'px';el.style.width=n.w+'px';el.style.height=n.h+'px';}}
 renderEdges();
});
function endDrag(){if(!drag)return;drag=null;persist();}
$('viewport').addEventListener('pointerup',endDrag);$('viewport').addEventListener('pointercancel',endDrag);
$('viewport').addEventListener('dblclick',ev=>{const n=ev.target.closest('[data-node]');if(n)selectNode(n.dataset.node);else if(!ev.target.closest('.floating-tools,.zoom-tools'))addNode('sticky',worldPoint(ev.clientX,ev.clientY));});
document.addEventListener('keydown',ev=>{
 if(ev.target.closest('input,textarea,select')||document.querySelector('dialog[open]'))return;
 if(ev.key==='Enter'&&ev.target.closest('[data-node]')){selectNode(ev.target.closest('[data-node]').dataset.node);ev.preventDefault();return;}
 if(ev.code==='Space'){space=true;ev.preventDefault();}
 if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='z'){ev.preventDefault();ev.shiftKey?redo():undo();return;}
 if(ev.key==='Delete'||ev.key==='Backspace'){if(selected.size){ev.preventDefault();change(()=>{state.nodes=state.nodes.filter(n=>!selected.has(n.id));state.edges=state.edges.filter(l=>!selected.has(l.from)&&!selected.has(l.to));selected.clear();});}return;}
 if(ev.key==='Escape'){selected.clear();setTool('select');render();}
 const map={v:'select',h:'hand',n:'sticky',t:'task',p:'person',f:'frame',c:'connect',d:'pen'};if(map[ev.key.toLowerCase()])setTool(map[ev.key.toLowerCase()]);
});
document.addEventListener('keyup',ev=>{if(ev.code==='Space')space=false;});window.addEventListener('blur',()=>{space=false;endDrag();});
window.addEventListener('beforeunload',ev=>{if(dirty){ev.preventDefault();ev.returnValue='';}});
async function init(){
 try{db=await requestDB();state=await read('state','workspace');if(!state){state=C.blank();try{const res=await fetch('private-review.json',{cache:'no-store'});if(res.ok){const data=await res.json();if(data.items)state=C.reviewImport(data,state).state;}}catch{}await write('state','workspace',state);}render();
 if(location.protocol.startsWith('http')&&'serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
 if(globalThis.chrome?.storage?.local){const {orbitCaptures=[]}=await chrome.storage.local.get('orbitCaptures');if(orbitCaptures.some(r=>!state.contacts.some(c=>c.captureId===r.id))){toast('New Gmail captures are ready in Import & connections.');}}
 }catch(err){$('save-status').textContent='Local storage unavailable';toast('This browser cannot open the local database. Try Chrome.');console.error(err);}
}
init();
