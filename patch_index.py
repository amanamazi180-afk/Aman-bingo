#!/usr/bin/env python3
# Usage:  python3 patch_index.py index.html
# Fixes missing / wrong number voices and adds the Amharic promo banner. Makes index.html.bak first.
import re, sys, shutil
p = sys.argv[1] if len(sys.argv) > 1 else "index.html"
s = open(p, encoding="utf-8").read()
if "pbn" in s and "getBuf" in s:
    sys.exit("Already patched.")
shutil.copy(p, p + ".bak")

def once(pat, rep, flags=0):
    global s
    if len(re.findall(pat, s, flags)) != 1:
        sys.exit("ANCHOR NOT FOUND (file unchanged): " + pat[:50])
    s = re.sub(pat, lambda m: rep, s, count=1, flags=flags)

VOICE = r"""/* VOICE v2 - every called number is spoken, in order, once.
   - each number is queued separately (before, only the last one of a batch was spoken)
   - sound files are loaded with retry (before, one failed download = that number silent forever)
   - a number waits for its own file instead of skipping or playing a different one */
const _a={},_bp={};let _cur=null,_q=[],_playing=false,_vt=0,_src=null,AC=null,_unl=false,wonSnd=0,_tok=0;
function aud(n){if(!_a[n]){const a=new Audio(n+".m4a");a.preload="auto";a.setAttribute("playsinline","");_a[n]=a}return _a[n]}
function ac(){if(!AC){try{AC=new(window.AudioContext||window.webkitAudioContext)()}catch(e){}}return AC}
function getBuf(k){if(_bp[k])return _bp[k];const c=ac();if(!c)return Promise.resolve(null);
  return _bp[k]=fetch(k+".m4a").then(r=>{if(!r.ok)throw 0;return r.arrayBuffer()}).then(ab=>new Promise((ok,no)=>{const p=c.decodeAudioData(ab,ok,no);if(p&&p.catch)p.catch(no)})).catch(()=>{delete _bp[k];return null})}
function preload(){const ks=[];for(let n=1;n<=75;n++)ks.push(n);ks.push("bingo");let i=0;
  const w=()=>{if(i>=ks.length)return;const k=ks[i++];getBuf(k).then(b=>b||getBuf(k)).then(b=>b||getBuf(k)).then(w)};w();w();w();w()}
function unlock(){const c=ac();if(!c)return;try{if(c.state!=="running")c.resume();if(!_unl){const s=c.createBufferSource();s.buffer=c.createBuffer(1,1,22050);s.connect(c.destination);s.start(0);_unl=true}}catch(e){}}
["touchstart","touchend","click"].forEach(e=>document.addEventListener(e,unlock,{passive:true}));
document.addEventListener("visibilitychange",()=>{if(!document.hidden)unlock()});
function stopVoice(){_tok++;_q=[];_playing=false;clearTimeout(_vt);if(_src){const s=_src;_src=null;s.onended=null;try{s.stop()}catch(e){}}if(_cur){try{_cur.pause()}catch(e){}_cur=null}}
function nextVoice(){clearTimeout(_vt);const n=_q.shift();if(n===undefined){_playing=false;return}
  _playing=true;const my=++_tok;let done=false;
  const fin=()=>{if(done||my!==_tok)return;done=true;clearTimeout(_vt);_src=null;nextVoice()};
  Promise.race([getBuf(n),new Promise(r=>setTimeout(()=>r(null),2000))]).then(b=>{
    if(my!==_tok)return;const c=AC;
    if(c&&b){try{if(c.state!=="running")c.resume();const s=c.createBufferSource();s.buffer=b;s.connect(c.destination);_src=s;s.onended=fin;
      _vt=setTimeout(()=>{try{s.stop()}catch(e){}fin()},Math.min(8000,b.duration*1000+800));s.start(0);return}catch(e){_src=null}}
    const a=aud(n);_cur=a;a.onended=a.onerror=fin;_vt=setTimeout(()=>{try{a.pause()}catch(e){}fin()},6000);
    try{a.currentTime=0;const p=a.play();if(p&&p.catch)p.catch(fin)}catch(e){fin()}})}
function playNum(n){if(!snd_on)return;_q.push(n);if(_q.length>4)_q.shift();if(!_playing)nextVoice()}
function fanfare(){try{if(!AC)return;if(AC.state==="suspended")AC.resume();const t=AC.currentTime;[[523,0],[659,.14],[784,.28],[1047,.42],[784,.62],[1047,.76],[1319,.9]].forEach(([f,d],i)=>{const o=AC.createOscillator(),g=AC.createGain();o.type="triangle";o.frequency.value=f;o.connect(g);g.connect(AC.destination);const a=t+d,e=a+(i===6?.9:.18);g.gain.setValueAtTime(.0001,a);g.gain.exponentialRampToValueAtTime(.35,a+.02);g.gain.exponentialRampToValueAtTime(.0001,e);o.start(a);o.stop(e+.05)})}catch(e){}}
function winSound(){if(!snd_on)return;stopVoice();getBuf("bingo").then(b=>{const c=AC;if(c&&b){try{if(c.state!=="running")c.resume();const s=c.createBufferSource();s.buffer=b;s.connect(c.destination);s.start(0);return}catch(e){}}fanfare()})}
function snd(){snd_on=!snd_on;if(!snd_on)stopVoice();$("sb").textContent=snd_on?"🔊":"🔇"}

"""
once(r"/\* VOICE - iPhone fix\..*?(?=/\* flow \*/)", VOICE, re.S)

# speak EVERY newly called number, in order (max 3 if the phone was asleep, so voice stays in sync with the screen)
once(r'if\(cl\.length>lastN\)\{lastN=cl\.length;if\(r\.status==="running"\)playNum\(n\)\}',
     'if(cl.length>lastN){const f=r.status==="running"?Math.max(lastN,cl.length-3):cl.length;for(let i=f;i<cl.length;i++)playNum(cl[i]);lastN=cl.length}')

CSS = r"""
/* promo banner */
.pbn{position:relative;flex:none;border-radius:18px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,.4)}
.pbt{display:flex;transition:transform .5s ease;touch-action:pan-y}
.pbs{min-width:100%;height:118px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;color:#fff;font-family:'Noto Sans Ethiopic','Abyssinica SIL',sans-serif}
.pbs div{flex:1;min-width:0}.pbs em{font-style:normal;font-size:34px;margin-left:8px}
.pbs span{display:inline-block;font-size:10px;font-weight:800;background:rgba(255,255,255,.22);padding:2px 9px;border-radius:20px;margin-bottom:6px}
.pbs b{display:block;font-size:17px;line-height:1.25;font-weight:900}.pbs small{display:block;font-size:12px;opacity:.92;margin-top:4px;line-height:1.35}
.pbd{position:absolute;bottom:6px;left:0;right:0;display:flex;justify-content:center;gap:5px}
.pbd i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.45);transition:.3s}.pbd i.on{width:18px;border-radius:4px;background:#fff}
.pb1{background:linear-gradient(135deg,#6a11cb,#2575fc)}.pb2{background:linear-gradient(135deg,#f7971e,#e8590c)}.pb3{background:linear-gradient(135deg,#0f9b8e,#1fbf6a)}
.pb4{background:linear-gradient(135deg,#ee0979,#ff6a00)}.pb5{background:linear-gradient(135deg,#0f2027,#2c5364)}.pb6{background:linear-gradient(135deg,#8e2de2,#4a00e0)}
"""
once(r"</style>", CSS + "</style>")

BN = r"""<div class="pbn" id="pbn"><div class="pbt" id="pbt">
    <div class="pbs pb1"><div><span>ፕሮሞሽን</span><b>አማን ቢንጎ — ይጫወቱ፣ ያሸንፉ!</b><small>ትልቅ ሽልማት በየጨዋታው ይጠብቅዎታል</small></div><em>🎯</em></div>
    <div class="pbs pb2"><div><span>ቦነስ</span><b>10 ብር የእንኳን ደህና መጡ ቦነስ</b><small>አዲስ ሲመዘገቡ ወዲያው ያገኛሉ</small></div><em>🎁</em></div>
    <div class="pbs pb3"><div><span>ሳምንታዊ ስጦታ</span><b>ከ1 እስከ 10 ደረጃ ሽልማት</b><small>በሳምንቱ ከፍተኛ ደረጃ የያዙ ይሸለማሉ</small></div><em>🏆</em></div>
    <div class="pbs pb4"><div><span>ዕለታዊ ስጦታ</span><b>በየቀኑ ስጦታ ለዕድለኞች</b><small>በየቀኑ ይጫወቱ፣ ስጦታ ያሸንፉ</small></div><em>🎉</em></div>
    <div class="pbs pb5"><div><span>ፈጣን ገቢ</span><b>ፈጣን ተቀማጭ ገንዘብ</b><small>ቴሌብር፣ ሲቢኢ፣ ዳሽን እና አቢሲኒያ</small></div><em>⚡</em></div>
    <div class="pbs pb6"><div><span>ፈጣን ወጪ</span><b>ያሸነፉትን ወዲያው ያውጡ</b><small>ፈጣን እና አስተማማኝ ወጪ</small></div><em>💰</em></div>
  </div><div class="pbd" id="pbd"></div></div>
  """
once(r'<div class="mid"><div class="logo">', BN + '<div class="mid"><div class="logo">')

JS = r"""/* promo banner slider */
(function(){const tr=$("pbt"),dt=$("pbd"),bn=$("pbn");if(!tr)return;const n=tr.children.length;let i=0,sx=null,t;
for(let k=0;k<n;k++)dt.appendChild(document.createElement("i"));
function go(x){i=(x+n)%n;tr.style.transform="translateX(-"+i*100+"%)";for(let k=0;k<n;k++)dt.children[k].className=k===i?"on":""}
function st(){clearInterval(t);t=setInterval(()=>{if($("home").classList.contains("on"))go(i+1)},4000)}
bn.addEventListener("touchstart",e=>{sx=e.touches[0].clientX;clearInterval(t)},{passive:true});
bn.addEventListener("touchend",e=>{if(sx!==null){const d=e.changedTouches[0].clientX-sx;if(Math.abs(d)>40)go(d<0?i+1:i-1)}sx=null;st()},{passive:true});
go(0);st()})();
"""
once(r"buildBoard\(\);\s*boot\(\);", JS + "buildBoard();\nboot();")

open(p, "w", encoding="utf-8").write(s)
print("DONE - index.html patched (backup: " + p + ".bak)")
