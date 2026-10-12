(function(){
'use strict';
if(document.getElementById('orbit-gmail-bridge'))return;
const box=document.createElement('div');box.id='orbit-gmail-bridge';
Object.assign(box.style,{position:'fixed',bottom:'84px',right:'24px',zIndex:'2147483000',display:'flex',gap:'6px',fontFamily:'Segoe UI, sans-serif'});
function button(text,fn){const b=document.createElement('button');b.textContent=text;b.type='button';Object.assign(b.style,{border:'1px solid #ddd4ed',borderRadius:'9px',background:'#7965dc',color:'white',padding:'10px 14px',fontSize:'12px',cursor:'pointer',boxShadow:'0 3px 12px #30204b20'});b.addEventListener('click',fn);box.append(b);return b;}
function feedback(text){const n=document.createElement('div');n.textContent=text;Object.assign(n.style,{position:'fixed',bottom:'138px',right:'24px',zIndex:'2147483000',background:'#fff',color:'#4f405b',border:'1px solid #ddd4ed',padding:'12px',borderRadius:'8px',maxWidth:'330px',font:'12px Segoe UI'});document.body.append(n);setTimeout(()=>n.remove(),4200);}
button('◌ Orbit board',()=>chrome.runtime.sendMessage({type:'orbit-open'}));
const save=button('Save thread to Orbit',()=>{
 const main=document.querySelector('[role="main"]'),subject=main?.querySelector('h2.hP')?.textContent?.trim();
 if(!subject){feedback('Open a Gmail conversation first. Orbit captures a thread you choose, not an inbox row.');return;}
 const self=(document.title.match(/[\w.+-]+@[\w.-]+\.[\w-]+/)||[])[0]?.toLowerCase();
 const senders=[...main.querySelectorAll('.adn .gD[email]')],external=senders.filter(s=>s.getAttribute('email')?.toLowerCase()!==self);
 const who=external[external.length-1]||senders[senders.length-1];
 if(!who){feedback('Could not identify a contact in this layout. Use Quick capture on the board.');return;}
 const body=[...main.querySelectorAll('.a3s')].filter(b=>b.getBoundingClientRect().height>0).slice(-3).map(b=>b.innerText).join('\n\n');
 const item={id:location.href,subject,name:who.getAttribute('name')||who.textContent.trim(),email:who.getAttribute('email'),context:'Captured from your open Gmail conversation. Reply status requires review.\n\n'+body.slice(-5500)};
 save.disabled=true;chrome.runtime.sendMessage({type:'orbit-capture',item},res=>{save.disabled=false;if(chrome.runtime.lastError||!res?.ok){feedback('Capture could not be saved. Try reloading Gmail after updating the extension.');return;}feedback('Saved privately. Open Orbit → Import & connections → Import captured Gmail threads.');});
});
document.body.append(box);
})();
