const assert=require('node:assert/strict'),C=require('../extension/workspace/core.js');
const fixture={items:[
{id:'R07',name:'Jane Example',company:'Example Studio',email:'jane@example.test',priority:'High',group:'You owe a reply',context:'Met at DICE and discussed a workshop.',note:'Send the agreed slides.',subject:'Workshop',draft:'Hi Jane,\nHere is [approved deck].',lastReceived:'2026-10-01',lastSent:'',gmailSearchUrl:'https://mail.google.com/mail/u/0/#search/Workshop'},
{id:'P01',name:'Alex Example',company:'Example Fund',email:'alex@example.test',priority:'High',group:'You owe a promised update',context:'Requested a deck.',note:'Prepare the deck.',subject:'Deck',draft:'Hi Alex,\nHere is [approved deck].'}
]};
let result=C.reviewImport(fixture,C.blank());assert.equal(result.count,2);assert.equal(result.state.contacts.length,2);assert.equal(C.reviewImport(fixture,result.state).count,0);
assert.ok(result.state.nodes.some(n=>n.board==='network'&&n.type==='person'));assert.ok(result.state.nodes.some(n=>n.board==='followups'&&n.type==='person'));
const contacts=C.linkedInCSV('Notes:\nExported contacts\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\r\nJane,Example,https://linkedin.com/in/jane,jane@example.test,"Example, Studio",Director,01 Oct 2026\r\nLee,New,https://linkedin.com/in/lee,,"North ""Blue""",Artist,02 Oct 2026');
assert.equal(contacts.length,2);assert.equal(contacts[0].company,'Example, Studio');assert.equal(contacts[1].company,'North "Blue"');
const merged=C.mergeContacts(result.state.contacts,contacts);assert.equal(merged.added,1);assert.equal(merged.matched,1);assert.equal(merged.contacts[0].memo,fixture.items[0].context);assert.equal(merged.contacts[0].linkedin,'https://linkedin.com/in/jane');
const parsed=C.parseCapture('Name: Nina Example\nCompany: North Studio\nRole: Producer\nnina@example.test\nhttps://linkedin.com/in/nina\nMet at IBC');
assert.equal(parsed.name,'Nina Example');assert.equal(parsed.company,'North Studio');assert.equal(parsed.role,'Producer');assert.equal(parsed.email,'nina@example.test');
assert.equal(C.safeURL('javascript:alert(1)'),'');assert.equal(C.safeURL('https://example.test'),'https://example.test/');
assert.throws(()=>C.csv('a,"unfinished'));assert.throws(()=>C.linkedInCSV('Name,Company\nA,B'));
assert.ok(C.draftFor({name:'Anna Smith',event:'DICE',memo:'virtual production',nextAction:'Could we have a short call?'}).includes('DICE'));
console.log('Orbit core: import, duplicate matching, draft context and URL safety checks passed.');
