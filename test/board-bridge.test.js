const assert=require('node:assert/strict'),vm=require('vm'),fs=require('fs'),path=require('path');
let listener,stored={},created=[];
const chrome={action:{onClicked:{addListener:()=>{}}},runtime:{getURL:s=>'chrome-extension://test/'+s,onMessage:{addListener:f=>listener=f}},tabs:{create:x=>created.push(x)},storage:{local:{get:async()=>structuredClone(stored),set:async x=>Object.assign(stored,structuredClone(x))}}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),{chrome,Promise,Date,String});
const capture=(id)=>new Promise(resolve=>listener({type:'orbit-capture',item:{id,subject:'Workshop',name:'Person',email:'person@example.test',context:'A real note.'}},{tab:{url:'https://mail.google.com/mail/u/0/#inbox/'+id}},resolve));
(async()=>{await Promise.all([capture('a'),capture('b')]);assert.equal(stored.orbitCaptures.length,2);await capture('a');assert.equal(stored.orbitCaptures.length,2);
let replied=false;listener({type:'orbit-capture',item:{id:'evil',subject:'No'}},{tab:{url:'https://example.test/'}},()=>replied=true);assert.equal(replied,false);
listener({type:'orbit-open'},{tab:{url:'https://mail.google.com/mail/u/0/'}},()=>{});assert.equal(created[0].url,'chrome-extension://test/workspace/index.html');
console.log('Gmail capture bridge: concurrent saves, duplicate capture update and sender-origin checks passed.');})().catch(err=>{console.error(err);process.exit(1);});
