/* User-triggered capture only. No sending, archiving or tab scraping. */
let captureQueue=Promise.resolve();
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('workspace/index.html')}));
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(!sender.tab?.url?.startsWith('https://mail.google.com/'))return;
 if(message.type==='orbit-open'){chrome.tabs.create({url:chrome.runtime.getURL('workspace/index.html')});reply({ok:true});return;}
 if(message.type!=='orbit-capture'||!message.item)return;
 const item=message.item;if(typeof item.id!=='string'||typeof item.subject!=='string')return;
 const safe={id:item.id.slice(0,500),subject:item.subject.slice(0,500),name:String(item.name||'').slice(0,200),email:String(item.email||'').slice(0,300),context:String(item.context||'').slice(0,6000),url:sender.tab.url,created:new Date().toISOString()};
 captureQueue=captureQueue.catch(()=>{}).then(async()=>{
  const {orbitCaptures=[]}=await chrome.storage.local.get('orbitCaptures');
  const list=orbitCaptures.filter(x=>x.id!==safe.id);list.push(safe);
  await chrome.storage.local.set({orbitCaptures:list.slice(-1000)});
 }).then(()=>reply({ok:true}),()=>reply({ok:false}));return true;
});
