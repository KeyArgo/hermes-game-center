// Real-browser checks for the ship gate; all activation uses CDP mouse events.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
const args = process.argv.slice(2), mode = args[0]
const arg = (name, fallback = '') => { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1] }
const out = path.resolve(arg('out', '.')), json = path.resolve(arg('json', path.join(out, mode + '.json')))
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.dirname(json), { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }); s.on('error', reject) })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-gate-page-'))
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless=new','--mute-audio','--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'], {stdio:'ignore'})
const stopChrome = () => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL') } catch {} }
process.on('exit', () => { stopChrome(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {} }); for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => process.exit(130))
let socket, pending = new Map(), seq = 0, errors = [], exceptions = []
try {
 let tabs
 for (let i=0;i<100;i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.length) break } catch {} await sleep(100) }
 if (!tabs?.length) throw Error('Chrome did not start')
  socket = new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl)
  // A stalled WebSocket handshake must fail the check, not hang the gate forever.
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP websocket did not open in 20s')),20000);socket.onopen=()=>{clearTimeout(timer);resolve()};socket.onerror=()=>{clearTimeout(timer);reject(Error('CDP websocket error'))}})
   socket.onmessage = event => { if(process.env.SHIP_GATE_DEBUG_MSG) console.log('msg',event.data.length,String(event.data).slice(0,80)); const v=JSON.parse(event.data); if(v.id && pending.has(v.id)){pending.get(v.id)(v.result || {});pending.delete(v.id)}; if(v.method==='Runtime.exceptionThrown') exceptions.push(v.params.exceptionDetails); if(v.method==='Runtime.consoleAPICalled' && ['error','warning'].includes(v.params.type)) errors.push(v.params.args.map(x=>x.value ?? x.description).join(' ')) }
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},20000);pending.set(id,x=>{clearTimeout(timer);resolve(x)});socket.send(JSON.stringify({id,method,params}))})
 const ev=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value}
 const mouse=async(x,y)=>{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',clickCount:1})}
 const shot=async name=>{const r=await cdp('Page.captureScreenshot',{format:'png'});if(r.data)fs.writeFileSync(path.join(out,name),Buffer.from(r.data,'base64'))}
 const visible=`e => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' && !!e.getClientRects().length }`
 const controls=`button,[role=button],a[href],input[type=button],summary`
 const press=async pattern=>{const p=await ev(`(() => {const visible=${visible}; const e=[...document.querySelectorAll(${JSON.stringify(controls)})].find(e=>visible(e)&&!e.disabled&&new RegExp(${JSON.stringify(pattern)},'i').test((e.innerText||e.value||e.getAttribute('aria-label')||'').trim()));if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(), t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x+r.width/2,y:r.y+r.height/2,ok:!!t&&(e===t||e.contains(t))}})()`);if(!p?.ok)return false;await mouse(p.x,p.y);await sleep(600);return true}
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1400,height:950,deviceScaleFactor:1,mobile:false})
 await cdp('Page.navigate',{url:new URL(arg('route',''),arg('url')).href});
 await (async()=>{for(let i=0;i<40;i++){if(await ev("document.body.innerText.includes('Welcome to Game Center')||document.body.innerText.includes('Ready to play')||document.body.innerText.includes('Play while you code')"))return;await sleep(500)}})()
 await sleep(500)
 if(await ev("document.body.innerText.includes('Welcome to Game Center')")) { if(!await press('^Skip for now$')) await press('^Continue$'); await sleep(1800) }
  const target=arg('surface'); if(target && !['lobby','side-pane','admin'].includes(target)) {
    await press(target); await sleep(1200)
    // The card press can land before the library finishes hydrating; wait for the game
    // page (its header Back button) and retry while it is still the library.
    const opened=async()=>await ev("Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Back')))")
    for(let i=0;i<12 && !(await opened());i++){await press(target);await sleep(600)}
    if(!(await opened())) throw Error('surface '+target+' did not open')
  }
 let result
 if(mode==='hygiene') {
   await sleep(2000)
   const points=await ev(`(() => {const visible=${visible};return [...document.querySelectorAll('button')].filter(visible).map(e=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}).filter(([x,y])=>x>=0&&y>=0&&x<innerWidth&&y<innerHeight)})()`)
   for(const [x,y] of points)await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y})
   await press('^(More options|How to play)$');await sleep(2000)
   const scan=await ev(`(() => {const visible=${visible};const nodes=[...document.querySelectorAll('body *')].filter(e=>!e.children.length&&visible(e));const text=nodes.map(e=>e.innerText||'').filter(Boolean);const labels=[...document.querySelectorAll(${JSON.stringify(controls)})].filter(visible).map(e=>(e.innerText||e.getAttribute('aria-label')||e.value||'').trim());const seats=!!document.querySelector('.games-seats,.games-talk-seat,[aria-label$=" seat"]');const all=text.join(' ');return {stray_text:text.filter(t=>/TODO|FIXME|XXX|\\bundefined\\b|\\bNaN\\b|\\[object |localhost:/i.test(t)),placeholder_labels:labels.filter(t=>/\\blocal\\b|placeholder|lorem/i.test(t)),badges:{human:/\\bhuman\\b/i.test(all),bot:/\\bbot\\b/i.test(all),computer:/\\bcomputer\\b/i.test(all)},seats}})()`)
   result={console_errors:errors,exceptions,...scan,warnings:[]};if(result.placeholder_labels.includes('Local')&&Object.values(result.badges).some(Boolean)){result.placeholder_labels=result.placeholder_labels.filter(x=>x!=='Local');result.warnings.push('Local seat badge')};result.pass=!errors.length&&!exceptions.length&&!scan.stray_text.length&&!result.placeholder_labels.length&&(!scan.seats||Object.values(scan.badges).some(Boolean))
 } else if(mode==='buttons') {
   const count=await ev(`document.querySelectorAll(${JSON.stringify(controls)}).length`);let rows=[]
   // Stable element references survive screen updates; never press a control twice.
   await ev(`window.__gateControls=[...document.querySelectorAll(${JSON.stringify(controls)})];window.__gateControls.sort((a,b)=>Number(/^(Back( to games)?|Close)$/i.test((a.innerText||'').trim()))-Number(/^(Back( to games)?|Close)$/i.test((b.innerText||'').trim())))`)
       const tBtn=Date.now()
    for(let i=0;i<count;i++) {console.log('press',i,'of',count,(Date.now()-tBtn)/1000+'s');const p=await ev(`(() => {const e=window.__gateControls[${i}], visible=${visible};if(!e||!e.isConnected||!visible(e))return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim(),x:r.x+r.width/2,y:r.y+r.height/2,covered:!t||!(t===e||e.contains(t)),disabled:!!e.disabled,reason:e.getAttribute('title')||e.getAttribute('aria-label')||e.innerText||''}})()`);if(!p)continue;const before=await ev('document.body.outerHTML');if(!p.covered&&!p.disabled)await mouse(p.x,p.y);await sleep(400);const after=await ev('document.body.outerHTML');const chrome=/^(Games|Champions|Settings|Play while you code|Community creations|Find a match|Open in browser)$/.test(p.label);rows.push({label:p.label,covered:p.covered,changed:before!==after,disabled:p.disabled,reason:p.reason,chrome,pass:chrome||(!p.covered&&(before!==after||(p.disabled&&!!p.reason.trim())))})
     // A confirmation opened by this press would swallow the next one; clear it the way a person would.
     const dialog=await ev("Boolean(document.querySelector('[role=alertdialog],[role=dialog]'))");if(dialog)await press('^(Cancel|Confirm replace match|Confirm rematch|OK|Close)$')}
   result={rows,pass:rows.length>0&&rows.every(r=>r.pass)};await shot('buttons.png')
 } else if(mode==='clear') {
   await shot('first-screen.png')
   // A game's how-to is its own header button (How to play); More options is the fallback.
   await press('^More options$');await sleep(400)
   const found=await press('how to play|tutorial|lesson|learn')
   let steps=0,completed=false,text=''
   if(found){await sleep(900);text=await ev('document.body.innerText')
     for(let i=0;i<40;i++){
       if(await press('^(next step|next|continue|done|finish|got it)$')){steps++;await sleep(700);continue}
       if(await press('^(?!Back( to games)?$|Close$).+')){steps++;await sleep(700);continue}
       break
     }
     completed=steps>0 && await ev("!/Next step/i.test(document.body.innerText)")
   }
   const goal=await ev("(document.body.innerText.split('\\n').find(x=>/goal|win|objective/i.test(x))||'')")
   fs.writeFileSync(path.join(out,'comprehension-prompt.txt'),`${text}\n\nGoal: ${goal}\nScreenshot: ${path.join(out,'first-screen.png')}\n`)
   result={found,steps,completed,reason:found?(completed?'':'tutorial did not complete'):'no tutorial found'}
 } else if(mode==='play') {
   await press(arg('action','^(Play a battle|Fight|Open|Start)$'));let moves=0,over=false;const deadline=Date.now()+240000
   while(Date.now()<deadline){over=await ev(`!![...document.querySelectorAll('[role=dialog],[role=alert],.games-result,[class*=overlay],[class*=banner]')].find(e=>/win|lose|draw|wins|victory|defeat|over|champion/i.test(e.innerText))`);if(over)break;if(!await press('^(?!Back( to games)?$|Close$).+'))break;moves++}
   result={result_overlay:over,moves,reason:over?'result shown':moves?'no result reached':'nothing playable found'};await shot('play.png')
 } else if(mode==='exit') {
   const overlayOpened=await press('^(More options|How to play)$')
   let esc='skip',escReason='no dialog to dismiss'
   const dialog=await ev("Boolean(document.querySelector('[role=dialog],dialog[open],[role=alertdialog]'))")
   if(dialog){for(const type of ['rawKeyDown','keyUp'])await cdp('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(500);const gone=await ev("!document.querySelector('dialog[open],[role=dialog],[role=alertdialog]')");esc=gone?'pass':'fail';escReason=gone?'dialog closed with Esc':'Esc did not close the dialog'}
   const back=await press('^Back( to games)?$');const overlap=await ev(`(() => {const visible=${visible},es=[...document.querySelectorAll(${JSON.stringify(controls)})].filter(visible),bad=[];for(let i=0;i<es.length;i++)for(let j=i+1;j<es.length;j++){const a=es[i],b=es[j],x=a.getBoundingClientRect(),y=b.getBoundingClientRect();if(x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top&&!a.contains(b)&&!b.contains(a)){for(const [e,r] of [[a,x],[b,y]]){const t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(t&&!e.contains(t)&&!t.contains(e))bad.push((e.innerText||e.getAttribute('aria-label')||e.tagName).trim())}}}return bad})()`)
   result={escape:{status:esc,reason:escReason},back:{status:back?'pass':'skip',reason:back?'':'Back unavailable or covered'},pane:{status:'skip',reason:'pane controls not present (Desktop chrome only)'},overlap:{status:overlap.length?'fail':'pass',pairs:overlap},pass:false};result.pass=Object.values(result).filter(x=>x&&typeof x==='object'&&x.status).every(x=>x.status==='pass')
  } else if(mode==='snapshot') {
   // A standalone copy of the real rendered screen (styles are already inline), so the
   // Impeccable detector can score it without inheriting this browser's session.
   const html=await ev("'<!doctype html>\\n'+document.documentElement.outerHTML")
   const file=path.join(out,'snapshot.html');fs.writeFileSync(file,html)
   result={snapshot:file,bytes:html.length,pass:html.length>500}
 } else throw Error('unknown check '+mode)
 fs.writeFileSync(json,JSON.stringify(result,null,2)+'\n')
} catch(e) {fs.writeFileSync(json,JSON.stringify({error:String(e.stack||e),pass:false},null,2)+'\n');process.exitCode=1} finally {if(socket)socket.close();stopChrome();await sleep(600);try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200})}catch{}}
