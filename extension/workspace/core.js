(function(root){
'use strict';
const uid=()=>globalThis.crypto?.randomUUID?.()||'o'+Date.now()+Math.random().toString(36).slice(2);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function csv(text){
 const rows=[];let row=[],cell='',quote=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===','&&!quote){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
 row.push(cell);if(row.some(x=>x.trim()))rows.push(row);if(quote)throw Error('The CSV has an unfinished quoted field.');return rows;
}
function linkedInCSV(text){
 const rows=csv(text.replace(/^\uFEFF/,''));let idx=rows.findIndex(r=>r.some(c=>c.trim().toLowerCase()==='first name')&&r.some(c=>c.trim().toLowerCase()==='last name'));
 if(idx<0)throw Error('Choose a LinkedIn Connections CSV with First Name and Last Name columns.');
 const head=rows[idx].map(c=>c.trim().toLowerCase());
 return rows.slice(idx+1).map(r=>{const get=k=>r[head.indexOf(k)]||'';return {id:uid(),name:[get('first name'),get('last name')].filter(Boolean).join(' ').trim(),company:get('company'),role:get('position'),email:get('email address'),linkedin:get('url'),event:'LinkedIn',memo:'',nextAction:'Decide how to reconnect',priority:'Medium',status:'To follow up',due:'',source:'LinkedIn CSV',created:new Date().toISOString(),connected:get('connected on')};}).filter(c=>c.name);
}
function samePerson(a,b){if(a.email&&b.email&&a.email.toLowerCase()===b.email.toLowerCase())return true;if(a.linkedin&&b.linkedin&&a.linkedin.replace(/\/$/,'').toLowerCase()===b.linkedin.replace(/\/$/,'').toLowerCase())return true;return a.name?.trim().toLowerCase()===b.name?.trim().toLowerCase()&&(a.company||'').trim().toLowerCase()===(b.company||'').trim().toLowerCase();}
function mergeContacts(existing,incoming){
 const out=structuredClone(existing);let added=0,matched=0;
 for(const c of incoming){const old=out.find(x=>samePerson(x,c));if(old){for(const k of ['email','linkedin','company','role','event'])if(!old[k]&&c[k])old[k]=c[k];matched++;}else {out.push(c);added++;}}return {contacts:out,added,matched};
}
function parseCapture(text){
 const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 const email=(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[])[0]||'';
 const linkedin=(text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s<>"']+/i)||[])[0]||'';
 const field=k=>{const l=lines.find(x=>new RegExp('^'+k+'\\s*:','i').test(x));return l?l.replace(/^[^:]+:\s*/,''):'';};
 return {name:field('name')||lines.find(x=>!x.includes('@')&&!/^https?:/.test(x))||'',company:field('company'),role:field('role|title'),email,linkedin,memo:lines.filter(x=>!/^name:|^company:|^role:|^title:|^https?:/i.test(x)&&!x.includes('@')).slice(1).join('\n')};
}
function safeURL(s){try{const u=new URL(s);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
function draftFor(c,channel='email'){
 const first=(c.name||'there').split(' ')[0];let text=c.draft||('Hi '+first+',\n\nIt was lovely connecting'+(c.event?' at '+c.event:'')+'. '+(c.memo?'I wanted to follow up on our conversation:\n'+c.memo+'\n\n':'\n\n')+(c.nextAction||'Would you be open to a short conversation about a possible collaboration?')+'\n\nElena');
 if(channel==='linkedin'&&!c.draft)text='Hi '+first+', it was lovely connecting'+(c.event?' at '+c.event:'')+'. '+(c.memo?'Following up on '+c.memo+'. ':'')+(c.nextAction||'I would be glad to stay in touch.');
 return text;
}
function blank(){
 return {version:1,boards:[{id:'network',name:'Networking',subtitle:'People & possibilities',camera:{x:90,y:90,z:.9}},{id:'followups',name:'Follow-ups',subtitle:'Close the open loops',camera:{x:90,y:90,z:.9}},{id:'today',name:'Today',subtitle:'One small step at a time',camera:{x:90,y:90,z:1}}],activeBoard:'network',contacts:[],nodes:[
 {id:uid(),board:'network',type:'frame',x:0,y:0,w:340,h:1000,title:'Reconnect',color:'lavender'},
 {id:uid(),board:'network',type:'frame',x:380,y:0,w:340,h:1000,title:'Build together',color:'mint'},
 {id:uid(),board:'network',type:'frame',x:760,y:0,w:340,h:1000,title:'Stay in touch',color:'peach'},
 {id:uid(),board:'today',type:'sticky',x:20,y:20,w:270,h:200,title:'Start smaller',body:'Pick one message.\nWrite the first sentence.\nReview it, then decide the next step.',color:'yellow'}
 ],edges:[],journal:[],xp:0,focusMinutes:0};
}
function reviewImport(data,state){
 if(!Array.isArray(data.items))throw Error('This is not a Gmail review file.');
 const s=structuredClone(state);let count=0;
 const network=new Set(['R05','R07','R08','R09','R10','R12','R13','R14','R15','R16','R17','R18','R19','R20','R21','R23','P01','P04','P05','F03','F04','F05','F06','F07','F12','W01','W02','W03','W04']);
 for(const r of data.items){
  if(s.contacts.some(c=>c.reviewId===r.id))continue;
  const c={id:uid(),reviewId:r.id,name:r.name||'Contact',company:r.company||'',email:r.email||'',role:'',linkedin:'',event:/DICE/.test(r.context+' '+r.subject)?'DICE':/Gamescom|Cologne/.test(r.context+' '+r.subject)?'Gamescom':/GDC/.test(r.context+' '+r.subject)?'GDC':'',memo:r.context||'',nextAction:r.note||'',priority:r.priority||'Medium',status:/Waiting|No reply/.test(r.group)?'Waiting':'To follow up',due:r.id==='A01'?'2026-10-16':'',source:'Gmail thread review · 12 Oct 2026',lastReceived:r.lastReceived||'',lastSent:r.lastSent||'',subject:r.subject||'',gmail:r.gmailSearchUrl||'',draft:r.draft||'',category:r.group||'',created:new Date().toISOString()};
  s.contacts.push(c);
  const col=/promised update/.test(r.group)&&/You owe/.test(r.group)?1:/Waiting|No reply/.test(r.group)?2:/Optional/.test(r.group)?3:0;
  const pos=s.nodes.filter(n=>n.board==='followups'&&n.type==='person'&&Math.floor(n.x/380)===col).length;
  s.nodes.push({id:uid(),board:'followups',type:'person',contactId:c.id,x:col*380+20,y:60+pos*228,w:295,h:202,color:['yellow','lavender','mint','peach'][col]});
  if(network.has(r.id)){
   const nc=/Optional/.test(r.group)?2:/deck|collaboration|Collaboration|initiative|Accelerator|Dev Event|Bootcamp/.test(r.subject+' '+r.context)?1:0;
   const np=s.nodes.filter(n=>n.board==='network'&&n.type==='person'&&Math.floor(n.x/380)===nc).length;
   s.nodes.push({id:uid(),board:'network',type:'person',contactId:c.id,x:nc*380+20,y:60+np*228,w:295,h:202,color:['lavender','mint','peach'][nc]});
  }count++;
 }
 const names=['Reply first','Promises to keep','Waiting on others','Optional / later'];
 names.forEach((title,i)=>{let f=s.nodes.find(n=>n.board==='followups'&&n.type==='frame'&&n.title===title);const h=100+228*s.nodes.filter(n=>n.board==='followups'&&n.type==='person'&&Math.floor(n.x/380)===i).length;if(!f)s.nodes.unshift({id:uid(),board:'followups',type:'frame',x:i*380,y:0,w:340,h:Math.max(650,h),title,color:['yellow','lavender','mint','peach'][i]});else f.h=Math.max(f.h,h);});
 s.nodes.filter(n=>n.board==='network'&&n.type==='frame').forEach(f=>{f.h=Math.max(f.h,100+228*s.nodes.filter(n=>n.board==='network'&&n.type==='person'&&n.x>=f.x&&n.x<f.x+f.w).length);});
 for(const rid of ['R01','R03','A01']){const c=s.contacts.find(c=>c.reviewId===rid);if(c&&!s.nodes.some(n=>n.board==='today'&&n.contactId===c.id))s.nodes.push({id:uid(),board:'today',type:'task',contactId:c.id,x:330,y:20+250*s.nodes.filter(n=>n.board==='today'&&n.type==='task').length,w:300,h:212,title:rid==='A01'?'Decide & RSVP by Oct 16':'Reply to '+c.name,body:c.nextAction,color:rid==='A01'?'lavender':'mint',done:false});}
 return {state:s,count};
}
const api={uid,today,csv,linkedInCSV,mergeContacts,samePerson,parseCapture,safeURL,draftFor,blank,reviewImport};
if(typeof module!=='undefined')module.exports=api;root.OrbitCore=api;
})(typeof window!=='undefined'?window:globalThis);
