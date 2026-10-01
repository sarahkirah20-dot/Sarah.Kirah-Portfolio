(function () {
  // -- Capture host references
  const realParent = window.parent;
  const cryptoObj = window.crypto;
  const RealURL = URL;

  // -- html-to-image (lazy-loaded for screenshots)
  const HTML_TO_IMAGE_SRC = "https://cdnjs.cloudflare.com/ajax/libs/html-to-image/1.11.13/html-to-image.min.js";
  const HTML_TO_IMAGE_INTEGRITY = "sha512-iZ2ORl595Wx6miw+GuadDet4WQbdSWS3JLMoNfY8cRGoEFy6oT3G9IbcrBeL6AfkgpA51ETt/faX6yLV+/gFJg==";
  const realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  let htmlToImageLoad = null;

  function loadHtmlToImage() {
    if (htmlToImageLoad) return htmlToImageLoad;
    htmlToImageLoad = (
      realFetch
        ? realFetch(HTML_TO_IMAGE_SRC, { integrity: HTML_TO_IMAGE_INTEGRITY, credentials: "omit", referrerPolicy: "no-referrer" })
        : Promise.reject(new Error("fetch unavailable"))
    )
      .then(function(res) {
        if (!res.ok) throw new Error("html-to-image failed to load (" + res.status + ")");
        return res.text();
      })
      .then(function(source) {
        var hidden = ["define", "module", "exports"].map(function(k) {
          var entry = { k: k, own: Object.prototype.hasOwnProperty.call(window, k), v: window[k] };
          try { window[k] = undefined; } catch (e) {}
          return entry;
        });
        try {
          var el = document.createElement("script");
          el.text = source;
          (document.head || document.documentElement).appendChild(el);
        } finally {
          hidden.forEach(function(item) {
            try { if (item.own) { window[item.k] = item.v; } else { delete window[item.k]; } } catch (e) {}
          });
        }
        if (!window.htmlToImage) throw new Error("html-to-image unavailable after load");
        return window.htmlToImage;
      });
    htmlToImageLoad.catch(function() { htmlToImageLoad = null; });
    return htmlToImageLoad;
  }

  // -- ID generator
  var newRequestId = (cryptoObj && typeof cryptoObj.randomUUID === "function")
    ? function() { return cryptoObj.randomUUID(); }
    : function() { return Date.now() + "-" + Math.random(); };

  // -- Console proxy
  var originalConsole = window.console;
  function sendConsole(level, args) {
    originalConsole[level](...args);
    var prefix = level === "log" ? "" : (level === "error" ? "Error: " : "Warning: ");
    realParent.postMessage({ type: "console", message: prefix + args.join(" ") }, "*");
  }
  window.console = {
    log:   function() { sendConsole("log",   Array.from(arguments)); },
    error: function() { sendConsole("error", Array.from(arguments)); },
    warn:  function() { sendConsole("warn",  Array.from(arguments)); },
  };

  // -- Pending callbacks & stream controllers
  var callbacksMap = new Map();
  var streamControllers = new Map();

  function makePromise(msgType, extra) {
    return new Promise(function(resolve, reject) {
      var id = newRequestId();
      callbacksMap.set(id, { resolve: resolve, reject: reject });
      realParent.postMessage(Object.assign({ type: msgType, id: id }, extra || {}), "*");
    });
  }

  // -- Claude bridge
  window.claude = {
    complete: function(prompt) { return makePromise("claudeComplete", { prompt: prompt }); },
  };

  // -- Storage bridge
  window.storage = {
    get:    function(key, shared)        { return makePromise("storageGet",    { key: key, shared: shared || false }); },
    set:    function(key, value, shared) { return makePromise("storageSet",    { key: key, value: value, shared: shared || false }); },
    delete: function(key, shared)        { return makePromise("storageDelete", { key: key, shared: shared || false }); },
    list:   function(prefix, shared)     { return makePromise("storageList",   { prefix: prefix, shared: shared || false }); },
  };

  // -- Blob URL shim
  var pendingBlobs = new Map();
  URL.createObjectURL = function(blob) {
    var blobId = "blob-" + Date.now() + "-" + Math.random();
    pendingBlobs.set(blobId, blob);
    return "blob-request://" + blobId;
  };
  URL.revokeObjectURL = function(url) {
    pendingBlobs.delete(url.replace("blob-request://", ""));
  };
  function getBlobFromURL(url) {
    return pendingBlobs.get(url.replace("blob-request://", ""));
  }

  // -- Fetch proxy (streaming support)
  window.fetch = function(url, init) {
    init = init || {};
    return new Promise(function(resolve, reject) {
      var id = newRequestId();
      var channelId = "fetch-" + id + "-" + Date.now();
      callbacksMap.set(id, {
        resolve: function(response) {
          if ([204, 205, 304].indexOf(response.status) !== -1) {
            try { resolve(new Response(null, response)); }
            catch (err) { reject(new TypeError("Bridge fetch: unconstructable response (status " + response.status + ")")); }
            return;
          }
          var stream = new ReadableStream({
            start: function(controller) { streamControllers.set(channelId, controller); },
            cancel: function() { streamControllers.delete(channelId); },
          });
          try { resolve(new Response(stream, response)); }
          catch (err) {
            streamControllers.delete(channelId);
            reject(new TypeError("Bridge fetch: unconstructable response (status " + response.status + ")"));
          }
        },
        reject: reject,
        channelId: channelId,
      });
      realParent.postMessage({ type: "proxyFetch", id: id, url: url, init: init, channelId: channelId }, "*");
    });
  };

  // -- Resolve link href (handles SVG AnimatedString)
  function resolvedHref(linkEl) {
    if (typeof linkEl.href === "string") return linkEl.href;
    var written = linkEl.href && linkEl.href.baseVal;
    if (!written || written.trim().charAt(0) === "#") return "";
    try { return new RealURL(written, linkEl.baseURI).href; }
    catch (e) { return written; }
  }

  // -- Message handler
  window.addEventListener("message", async function(event) {
    if (event.source !== realParent) return;
    var type = event.data.type;
    var id   = event.data.id;

    if (type === "takeScreenshot") {
      var nonce = event.data.nonce;
      var root = document.getElementById("artifacts-component-root-html");
      if (!root) {
        realParent.postMessage({ type: "screenshotError", nonce: nonce, error: new Error("Root element not found") }, "*");
        return;
      }
      try {
        var lib  = await loadHtmlToImage();
        var data = await lib.toPng(root, {
          imagePlaceholder: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAA1JREFUGFdjePDgwX8ACOQDoNsk0PMAAAAASUVORK5CYII=",
        });
        realParent.postMessage({ type: "screenshotData", nonce: nonce, data: data }, "*");
      } catch (err) {
        realParent.postMessage({ type: "screenshotError", nonce: nonce, error: err instanceof Error ? err : new Error(String(err)) }, "*");
      }
      return;
    }

    if (["claudeComplete","storageGet","storageSet","storageDelete","storageList"].indexOf(type) !== -1) {
      var cb = callbacksMap.get(id);
      if (!cb) return;
      if (event.data.error) { cb.reject(new Error(event.data.error)); }
      else { cb.resolve(event.data.result !== undefined ? event.data.result : event.data.completion); }
      callbacksMap.delete(id);
      return;
    }

    if (type === "proxyFetchResponse") {
      var cb = callbacksMap.get(id);
      if (!cb) return;
      if (event.data.error) {
        cb.reject(new Error(event.data.error));
        callbacksMap.delete(id);
      } else {
        cb.resolve({ status: event.data.status, statusText: event.data.statusText, headers: event.data.headers });
        if (!event.data.body) callbacksMap.delete(id);
      }
      return;
    }

    if (type === "proxyFetchStream") {
      var controller = streamControllers.get(event.data.channelId);
      if (!controller) return;
      if (event.data.error) {
        controller.error(new Error(event.data.error));
        streamControllers.delete(event.data.channelId);
      } else if (event.data.done) {
        controller.close();
        streamControllers.delete(event.data.channelId);
        for (var entry of callbacksMap) {
          if (entry[1].channelId === event.data.channelId) { callbacksMap.delete(entry[0]); break; }
        }
      } else if (event.data.chunk) {
        controller.enqueue(new Uint8Array(event.data.chunk));
      }
    }
  });

  // -- Link click handler
  window.addEventListener("click", function(event) {
    if (typeof event.target.closest !== "function") return;
    var linkEl = event.target.closest("a");
    var href = linkEl && resolvedHref(linkEl);
    if (!href) return;
    var filename = linkEl.getAttribute("download") || "";
    event.preventDefault();
    event.stopImmediatePropagation();
    if (href.indexOf("blob-request:") === 0) {
      var blob = getBlobFromURL(href);
      if (!blob) return;
      blob.arrayBuffer().then(function(data) {
        realParent.postMessage({ type: "downloadFile", filename: filename, data: data, mimeType: blob.type || "application/octet-stream" });
      });
    } else if (href.indexOf("data:") === 0) {
      var parts = href.split(",");
      var mimeMatch = parts[0].match(/data:([^;]+)/);
      var mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";
      var data = Uint8Array.from(atob(parts[1]), function(c) { return c.charCodeAt(0); }).buffer;
      realParent.postMessage({ type: "downloadFile", filename: filename, data: data, mimeType: mimeType });
    } else {
      var linkUrl;
      try { linkUrl = new URL(href); } catch (e) { return; }
      if (linkUrl.hostname === window.location.hostname) return;
      realParent.postMessage({ type: "openExternal", href: href }, "*");
    }
  });

  // -- window.open override
  window.open = function(url) {
    realParent.postMessage({ type: "openExternal", href: url }, "*");
  };

  // -- Uncaught error forwarding
  window.addEventListener("error", function(event) {
    realParent.postMessage({ type: "console", message: "Uncaught Error: " + event.message }, "*");
  });
})();


// ============================================================
// App Logic
// ============================================================
const KEY='designer_site_v2';
const SRC='<!DOCTYPE html>\n'+document.documentElement.outerHTML;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const AR={};$$('[data-k]').forEach(el=>AR[el.dataset.k]=el.innerHTML);
const EN={brand:'Your Name',navcta:'Start a project',nv1:'Work',nv2:'Clients',nv3:'About',nv4:'Contact',role:'Graphic designer & brand identity',
hero:'I create<br>designs people remember',herop:'I turn your idea into a visual identity and designs that catch the eye and stay in memory.',hb1:'View my work',hb2:'Get in touch',
l1:'Happy clients',l2:'Projects delivered',l3:'Years of experience',l4:'Full brand identities',
t_works:'My work',s_works:'A selection of projects I have designed.',t_clients:'Clients who trusted me',s_clients:'Companies and brands I have worked with.',
t_about:'About me',about1:'I am a graphic designer who believes good design tells a brand\u2019s story before it says a word.',
about2:'I work with business owners and companies to build clear, consistent visual identities, from the logo to packaging and social media.',
sv1:'Brand identity & logos',sv2:'Social media design',sv3:'Packaging design',sv4:'Print & advertising',
t_contact:'Have a project?<br>Let\u2019s start.',s_contact:'Send me a message and I will reply as soon as possible.',foot:'\u00a9 All rights reserved'};
const UI={en:{edit:'\u270e Edit',done:'\u2713 Done',hint:'Click any text to edit it, and boxes to upload images',reset:'Reset edits',rc:'Reset all edits to the original?',addW:'+ Add design',addL:'+ Add logo',le:'Drop client logo here',we:'Drop your design here',la:'Client logo',full:'Storage is full: use smaller images',lp:'Paste the link (leave empty to clear)',lang:'\u0627\u0644\u0639\u0631\u0628\u064a\u0629',title:'Portfolio | Graphic Designer',back:'\u2190 Back',addI:'+ Add images',descPh:'Write a description of this project...',noimg:'Add images to this project',rn:'New uploads will use this size',exp:'\u2b07 Save site file',saved:'File downloaded. Upload it to GitHub as index.html',addC:'+ Add card',ph:'Add image'},
ar:{edit:'\u270e تعديل',done:'\u2713 تم',hint:'اضغطي على أي نص لتعديله، وعلى المربعات لرفع الصور',reset:'مسح التعديلات',rc:'مسح كل التعديلات والرجوع للشكل الأصلي؟',addW:'+ إضافة تصميم',addL:'+ إضافة شعار',le:'ضعي شعار العميل هنا',we:'ضعي تصميمك هنا',la:'شعار عميل',full:'المساحة ممتلئة: قلّلي حجم الصور',lp:'الصقي الرابط (اتركيه فارغًا للمسح)',lang:'English',title:'معرض أعمال | مصممة جرافيك',back:'رجوع \u2192',addI:'+ إضافة صور',descPh:'اكتبي وصف المشروع هنا...',noimg:'أضيفي صور لهذا المشروع',rn:'الصور الجديدة هتتقص بالمقاس ده',exp:'\u2b07 حفظ ملف الموقع',saved:'اتنزل الملف. ارفعيه على GitHub باسم index.html',addC:'+ إضافة كارت',ph:'أضيفي صورة'}};
const WD={en:{title:'Project name',cats:['Brand identity','Social media','Packaging','Logo','Advertising','Print']},ar:{title:'اسم المشروع',cats:['هوية بصرية','سوشيال ميديا','تغليف','شعار','إعلان','مطبوعات']}};
const DEF={lang:'en',ratio:'4x5',t:{},links:{linkedin:'https://www.linkedin.com/in/sarah-kirah-4920662b8/',behance:'https://www.behance.net/sarahkirah',facebook:'https://www.facebook.com/sarah.kirah.184',instagram:'https://www.instagram.com/sarah_kirah57/'},logos:[null,null,null,null,null,null],works:[{img:null},{img:null},{img:null},{img:null},{img:null},{img:null}],accent:'#ff4d8d'};
let S=JSON.parse(JSON.stringify(DEF));
let seed={},loc=null;try{seed=JSON.parse(document.getElementById('seed').textContent||'{}')}catch(e){}
try{const raw=localStorage.getItem(KEY);if(raw)loc=JSON.parse(raw)}catch(e){}
S=Object.assign(S,(loc&&(loc.ts||0)>=(seed.ts||0))?loc:seed);
let editing=false,pick=null;
const L=n=>S.links[n]||DEF.links[n];
const u=k=>UI[S.lang][k],sk=k=>/^(n\d|c\d)$/.test(k)?k:S.lang+':'+k,sfx=()=>S.lang==='ar'?'_ar':'';
function save(){S.ts=Date.now();try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){toast(u('full'))}}
function toast(m){const t=$('#toast');t.textContent=m;t.style.display='block';clearTimeout(toast.h);toast.h=setTimeout(()=>t.style.display='none',2600)}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}

function renderLogos(){
 const any=S.logos.some(Boolean);
 $('#logosGrid').innerHTML=S.logos.map((l,i)=>l?`<div class="lg" data-i="${i}"><img src="${l}" alt="${u('la')}"><button class="x" data-del="${i}" aria-label="x">\u00d7</button></div>`
 :`<div class="lg empty ${any?'hide':''}" data-i="${i}">${u('le')}<button class="x" data-del="${i}" aria-label="x">\u00d7</button></div>`).join('');
}
function renderWorks(){
 const d=WD[S.lang],f=sfx();
 $('#worksGrid').innerHTML=S.works.map((w,i)=>{const ti=w['title'+f]??d.title,ca=w['cat'+f]??d.cats[i%6];
 return `<article class="wk" data-i="${i}"><div class="ph ${cv(w)?'':'g'}" style="aspect-ratio:${arOf(w)==='1x1'?'1/1':'4/5'}">${cv(w)?`<img src="${cv(w)}" alt="${esc(ti)}">`:u('we')}</div>
 <div class="cap"><b data-w="title" contenteditable="${editing}">${ti}</b><span data-w="cat" contenteditable="${editing}">${ca}</span></div>
 <button class="arb" data-arw="${i}" type="button">${arOf(w)==='1x1'?'1080\u00d71080':'1080\u00d71350'}</button>
 <button class="op" data-open="${i}" aria-label="open">\u2197</button>
 <button class="x" data-delw="${i}" aria-label="x">\u00d7</button></article>`}).join('');observeCards();
}
function renderSoc(){$$('[data-soc]').forEach(a=>{const l=L(a.dataset.soc);a.href=l||'#';if(l){a.target='_blank';a.rel='noopener'}else a.removeAttribute('target')})}
function applyLang(){
 const L=S.lang,D=document.documentElement;D.lang=L;D.dir=L==='ar'?'rtl':'ltr';document.title=u('title');
 $$('[data-k]').forEach(el=>{const k=el.dataset.k,v=S.t[sk(k)],d=(L==='ar'?AR:EN)[k];el.innerHTML=v!=null?v:(d!=null?d:el.innerHTML)});
 $('#langBtn').textContent=u('lang');$('#editBtn').textContent=editing?u('done'):u('edit');
 $('#reset').textContent=u('reset');$('#expBtn').textContent=u('exp');$('#addWork').textContent=u('addW');$('#addLogo').textContent=u('addL');
 renderLogos();renderWorks();renderSoc();fillMq();setRatio();if(cur>=0)renderProj();
}
$$('[data-k]').forEach(el=>el.addEventListener('input',()=>{S.t[sk(el.dataset.k)]=el.innerHTML;save();if(el.hasAttribute('data-count'))el.dataset.to=el.textContent.trim();if(/^sv/.test(el.dataset.k))fillMq()}));
document.documentElement.style.setProperty('--accent',S.accent);$('#accent').value=S.accent;
$('#accent').addEventListener('input',e=>{S.accent=e.target.value;document.documentElement.style.setProperty('--accent',S.accent);save()});
$('#langBtn').onclick=()=>{S.lang=S.lang==='en'?'ar':'en';save();applyLang()};

document.addEventListener('click',e=>{
 const so=e.target.closest('[data-soc]');
 if(so){const n=so.dataset.soc;
  if(editing){e.preventDefault();let v=prompt(u('lp'),L(n));if(v!==null){v=v.trim();if(v&&!/^https?:\/\//.test(v))v='https://'+v;S.links[n]=v;save();renderSoc()}}
  else if(!L(n))e.preventDefault();
  return}
 if(editing&&e.target.closest('a[data-k]')){e.preventDefault();return}
 const ab=e.target.closest('[data-arw]');if(ab){const w=S.works[+ab.dataset.arw];w.ar=arOf(w)==='1x1'?'4x5':'1x1';save();renderWorks();return}
 const op=e.target.closest('[data-open]');if(op){openProj(+op.dataset.open);return}
 if(e.target.closest('#pjBack')){location.hash='works';return}
 if(e.target.closest('#pjPrev')){go(-1);return}
 if(e.target.closest('#pjNext')){go(1);return}
 const di=e.target.closest('[data-delimg]');if(di){imgsOf(S.works[cur]).splice(+di.dataset.delimg,1);save();renderProj();return}
 const cd=e.target.closest('#deck .cd');
 if(cd){if(moved>8)return;const j=+cd.dataset.j;if(j!==Math.round(pos))goTo(j);else if(editing){if(cd.classList.contains('g')){pick={type:'slot',j};$('#fileIn').click()}}else{const im=cd.querySelector('img');if(im){$('#lb img').src=im.src;$('#lb').classList.add('on')}}return}
 const dl=e.target.closest('[data-del]'),dw=e.target.closest('[data-delw]');
 if(dl){S.logos.splice(+dl.dataset.del,1);save();renderLogos();return}
 if(dw){S.works.splice(+dw.dataset.delw,1);save();renderWorks();return}
 const lg=e.target.closest('.lg'),ph=e.target.closest('.wk .ph');
 if(editing&&lg){pick={type:'logo',i:+lg.dataset.i};$('#fileIn').click();return}
 if(editing&&ph){pick={type:'work',i:+ph.closest('.wk').dataset.i};$('#fileIn').click();return}
 if(!editing){const wk=e.target.closest('.wk');if(wk&&!e.target.closest('.x')){openProj(+wk.dataset.i);return}}
 if(e.target.closest('#lb'))$('#lb').classList.remove('on');
});
document.addEventListener('input',e=>{
 const pw=e.target.closest('[data-pw]');if(pw&&cur>=0){S.works[cur][pw.dataset.pw+sfx()]=pw.innerHTML;save();if(pw.dataset.pw==='title')$('#pjBig').textContent=pw.textContent;return}
 const f=e.target.closest('[data-w]');if(!f)return;
 S.works[+f.closest('.wk').dataset.i][f.dataset.w+sfx()]=f.innerHTML;save()});
$('#addLogo').onclick=()=>{S.logos.push(null);save();renderLogos()};
$('#addWork').onclick=()=>{S.works.push({img:null});save();renderWorks()};

$('#fileIn').addEventListener('change',e=>{
 const f=e.target.files[0];e.target.value='';if(!f||!pick)return;const pk=pick;
 if(pk.type==='slot'){fit(f,url=>{imgsOf(S.works[cur])[pk.j]=url;save();renderProj()},arOf(S.works[cur]));return}
 if(pk.type==='work'){fit(f,url=>{S.works[pk.i].img=url;save();renderWorks()},arOf(S.works[pk.i]));return}
 const rd=new FileReader();rd.onload=()=>{const im=new Image();im.onload=()=>{const sc=Math.min(1,600/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=im.width*sc;c.height=im.height*sc;c.getContext('2d').drawImage(im,0,0,c.width,c.height);S.logos[pk.i]=c.toDataURL('image/png');save();renderLogos()};im.src=rd.result};rd.readAsDataURL(f)});

$('#editBtn').onclick=()=>{
 editing=!editing;document.body.classList.toggle('edit',editing);$('#editBtn').classList.toggle('on',editing);
 $('#editBtn').textContent=editing?u('done'):u('edit');
 $$('[data-k],[data-w],[data-pw]').forEach(el=>el.contentEditable=editing);
 $$('a[data-k]').forEach(a=>{if(editing){if(a.hasAttribute('href')){a.dataset.h=a.getAttribute('href');a.removeAttribute('href')}}else if(a.dataset.h)a.setAttribute('href',a.dataset.h)});
 if(cur>=0)renderProj();
 if(editing)toast(u('hint'));
};
$('#reset').onclick=()=>{if(confirm(u('rc'))){try{localStorage.removeItem(KEY)}catch(e){}location.reload()}};

const sp=$('#spot');
$('.hero').addEventListener('pointermove',e=>{const r=e.currentTarget.getBoundingClientRect();sp.style.left=(e.clientX-r.left)+'px';sp.style.top=(e.clientY-r.top)+'px';e.currentTarget.style.setProperty('--mx',(e.clientX-r.left)/r.width-.5);e.currentTarget.style.setProperty('--my',(e.clientY-r.top)/r.height-.5)});

const RM=matchMedia('(prefers-reduced-motion:reduce)').matches;
function fillMq(){const g=['sv1','sv2','sv3','sv4'].map(k=>'<span>'+$('[data-k="'+k+'"]').textContent+'</span>').join('');$('#mq').innerHTML=g+g+g+g}
const cio=new IntersectionObserver(es=>es.forEach(en=>{if(!en.isIntersecting)return;const el=en.target;cio.unobserve(el);
 el.style.setProperty('--d',([...el.parentNode.children].indexOf(el)%3)*.14+'s');el.classList.add('in')}),{threshold:.12});
function observeCards(){$$('.wk').forEach(el=>cio.observe(el))}
document.addEventListener('pointermove',e=>{
 const c=e.target.closest&&e.target.closest('.wk');if(!c||editing||RM)return;
 const r=c.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
 c.style.setProperty('--ry',(x-.5)*14+'deg');c.style.setProperty('--rx',(.5-y)*14+'deg');
 c.style.setProperty('--gx',x*100+'%');c.style.setProperty('--gy',y*100+'%');
 c.style.setProperty('--px',(.5-x)*18+'px');c.style.setProperty('--py',(.5-y)*18+'px')});
document.addEventListener('pointerout',e=>{const c=e.target.closest&&e.target.closest('.wk');
 if(c&&!c.contains(e.relatedTarget))['--rx','--ry','--px','--py'].forEach(v=>c.style.removeProperty(v))});
const prog=$('#prog');
addEventListener('scroll',()=>{const h=document.documentElement;prog.style.transform='scaleX('+(scrollY/((h.scrollHeight-innerHeight)||1))+')'},{passive:true});
if(!RM)$$('.hero .btn,.navr .btn').forEach(b=>{
 b.addEventListener('pointermove',e=>{if(editing)return;const r=b.getBoundingClientRect();b.style.translate=(e.clientX-r.left-r.width/2)*.25+'px '+(e.clientY-r.top-r.height/2)*.35+'px'});
 b.addEventListener('pointerleave',()=>b.style.translate='')});
let cur=-1,act=0,moved=0,dx0=null,lw=0;
const arOf=w=>w.ar||S.ratio;
const cv=w=>w.img||(w.imgs&&w.imgs[0])||null;
function setRatio(){document.documentElement.style.setProperty('--ar',S.ratio==='1x1'?'1/1':'4/5');$('#ratioBtn').textContent=S.ratio==='1x1'?'1080\u00d71080':'1080\u00d71350'}
function fit(file,cb,r){const rd=new FileReader();rd.onload=()=>{const im=new Image();im.onload=()=>{const W=1080,H=(r||S.ratio)==='1x1'?1080:1350,c=document.createElement('canvas');c.width=W;c.height=H;
 const sc=Math.max(W/im.width,H/im.height),w=im.width*sc,h=im.height*sc;c.getContext('2d').drawImage(im,(W-w)/2,(H-h)/2,w,h);cb(c.toDataURL('image/jpeg',.75))};im.src=rd.result};rd.readAsDataURL(file)}
$('#expBtn').onclick=()=>{S.ts=Date.now();const json=JSON.stringify(S).replace(/</g,'\\u003c');
 const out=SRC.replace(/(<script id="seed" type="application\/json">)[\s\S]*?(<\/script>)/,(m,a,b)=>a+json+b);
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out],{type:'text/html'}));a.download='index.html';document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(a.href),4000);toast(u('saved'))};
$('#ratioBtn').onclick=()=>{S.ratio=S.ratio==='1x1'?'4x5':'1x1';save();setRatio();toast(u('rn'))};
function openProj(i){location.hash='p='+i}
function route(){const m=location.hash.match(/^#p=(\d+)$/);
 if(m&&S.works[+m[1]]){cur=+m[1];pos=0;$('#pj').classList.add('on');document.body.style.overflow='hidden';renderProj();$('#pj').scrollTop=0}
 else if(cur>=0){cur=-1;$('#pj').classList.remove('on');document.body.style.overflow='';renderWorks()}}
addEventListener('hashchange',route);
const PAL=['#2a0a1a,#ff4d8d','#0a1a2a,#3d7bff','#1a1a1a,#8d8d8d','#1a0a2a,#8a4dff','#2a1a0a,#ff9b3d','#0a2a1f,#2dd4a0'];
let pos=0;
const imgsOf=w=>w.imgs||(w.imgs=[null,null,null,null,null]);
function renderProj(){
 const w=S.works[cur];if(!w)return;const f=sfx(),d=WD[S.lang];
 $('#pjT').innerHTML=w['title'+f]??d.title;$('#pjC').innerHTML=w['cat'+f]??d.cats[cur%6];$('#pjD').innerHTML=w['desc'+f]??'';
 $('#pjBig').textContent=$('#pjT').textContent;$('#pjBack').textContent=u('back');$('#addImgs').textContent=u('addI');$('#addCard').textContent=u('addC');$('#pj').style.setProperty('--ar',arOf(w)==='1x1'?'1/1':'4/5');$('#arBtn').textContent=arOf(w)==='1x1'?'1080\u00d71080':'1080\u00d71350';$('#pjD').dataset.ph=u('descPh');
 $$('[data-pw]').forEach(el=>el.contentEditable=editing);
 const all=w.imgs||[null,null,null,null,null],list=(editing||!all.some(Boolean))?all:all.filter(Boolean);
 $('#deck').innerHTML=list.map((src,j)=>src?`<div class="cd" data-j="${j}"><img src="${src}" alt=""><button class="x" data-delimg="${j}" aria-label="x">\u00d7</button></div>`
  :`<div class="cd g" data-j="${j}" style="background:linear-gradient(140deg,${PAL[j%6]})"><div><b>${j+1}</b><span>${u('ph')}</span></div><button class="x" data-delimg="${j}" aria-label="x">\u00d7</button></div>`).join('');
 pos=Math.max(0,Math.min(list.length-1,Math.round(pos)));layout();
}
function layout(){const cs=$$('#deck .cd');cs.forEach((c,j)=>{const dd=j-pos,a=Math.abs(dd);c.style.setProperty('--d',dd);c.style.setProperty('--a',a);c.style.zIndex=Math.round(100-a*10);
 c.style.opacity=Math.max(0,Math.min(1,3.6-a));c.style.pointerEvents=a>3.2?'none':'';c.classList.toggle('act',Math.round(pos)===j)});
 $('#pjN').textContent=cs.length?(Math.round(pos)+1)+' / '+cs.length:''}
function goTo(j){const n=$$('#deck .cd').length;pos=Math.max(0,Math.min(n-1,j));layout()}
function go(n){goTo(Math.round(pos)+n)}
$('#addImgs').onclick=()=>$('#fileMulti').click();
$('#arBtn').onclick=()=>{const w=S.works[cur];w.ar=arOf(w)==='1x1'?'4x5':'1x1';save();renderProj();toast(u('rn'))};
$('#addCard').onclick=()=>{const im=imgsOf(S.works[cur]);im.push(null);pos=im.length-1;save();renderProj()};
$('#fileMulti').addEventListener('change',e=>{const fs=[...e.target.files];e.target.value='';if(cur<0||!fs.length)return;const im=imgsOf(S.works[cur]),res=[];let n=fs.length;
 fs.forEach((f,k)=>fit(f,url=>{res[k]=url;if(--n===0){res.forEach(x=>{const e0=im.indexOf(null);if(e0>=0)im[e0]=x;else im.push(x)});pos=im.indexOf(res[0]);save();renderProj()}},arOf(S.works[cur])))});
const stg=$('#stage');let px0=0,pos0=0,lx=0,lt=0,vx=0,wt;
const unit=()=>{const c=$('#deck .cd');return Math.max(120,(c?c.offsetWidth:300)*.55)};
stg.addEventListener('pointerdown',e=>{if(e.button>0)return;dx0=e.clientX;px0=e.clientX;pos0=pos;lx=e.clientX;lt=performance.now();vx=0;moved=0});
addEventListener('pointermove',e=>{if(dx0==null)return;const dx=e.clientX-px0;moved=Math.max(moved,Math.abs(dx));if(moved>8)stg.classList.add('drag');
 const now=performance.now(),dt=now-lt;if(dt>0)vx=.8*vx+.2*((e.clientX-lx)/dt);lx=e.clientX;lt=now;
 const n=$$('#deck .cd').length;pos=Math.max(-.3,Math.min(n-.7,pos0-dx/unit()));layout()});
function endDrag(){if(dx0==null)return;dx0=null;if(!stg.classList.contains('drag'))return;stg.classList.remove('drag');
 const n=$$('#deck .cd').length;pos=Math.max(0,Math.min(n-1,Math.round(pos-vx*220/unit())));layout()}
addEventListener('pointerup',endDrag);addEventListener('pointercancel',endDrag);
stg.addEventListener('wheel',e=>{const x=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:0;if(!x)return;e.preventDefault();stg.classList.add('drag');
 const n=$$('#deck .cd').length;pos=Math.max(0,Math.min(n-1,pos+x/(unit()*1.6)));layout();
 clearTimeout(wt);wt=setTimeout(()=>{stg.classList.remove('drag');pos=Math.round(pos);layout()},150)},{passive:false});
addEventListener('keydown',e=>{if(e.target.isContentEditable)return;
 if(e.key==='Escape'){if($('#lb').classList.contains('on'))$('#lb').classList.remove('on');else if(cur>=0)location.hash='works'}
 else if(cur>=0&&e.key==='ArrowLeft')go(-1);else if(cur>=0&&e.key==='ArrowRight')go(1)});
$('#pj').addEventListener('pointermove',e=>{const p=$('#pj'),x=e.clientX/innerWidth-.5,y=e.clientY/innerHeight-.5;
 p.style.setProperty('--mx',x);p.style.setProperty('--my',y);
 $$('#pj .ly').forEach(l=>{const d=+l.dataset.d;l.style.transform='translate('+x*d+'px,'+y*d+'px)'});
 const c=e.target.closest('.cd.act');if(c){const r=c.getBoundingClientRect();c.style.setProperty('--gx',(e.clientX-r.left)/r.width*100+'%');c.style.setProperty('--gy',(e.clientY-r.top)/r.height*100+'%')}});
const ring=$('#cur');let cx=0,cy=0,tx=0,ty=0;
if(matchMedia('(hover:hover)').matches&&!RM){
 addEventListener('pointermove',e=>{tx=e.clientX;ty=e.clientY;ring.classList.toggle('big',!!e.target.closest('.wk,.btn,.lg,.cd,a,button'))});
 (function loop(){cx+=(tx-cx)*.18;cy+=(ty-cy)*.18;ring.style.transform='translate('+cx+'px,'+cy+'px)';requestAnimationFrame(loop)})();
}else ring.style.display='none';

applyLang();route();
function countUp(){$$('[data-count]').forEach(el=>{const v=el.dataset.to||(el.dataset.to=el.textContent.trim()),n=parseInt(v.replace(/\D/g,''),10);
 if(!n||editing||RM)return;const suf=v.replace(/[0-9]/g,'');let t0=null;
 const step=ts=>{t0=t0||ts;const p=Math.min((ts-t0)/1800,1);el.textContent=Math.round(n*(1-Math.pow(1-p,3)))+suf;if(p<1)requestAnimationFrame(step)};
 el.textContent='0'+suf;requestAnimationFrame(step)})}
new IntersectionObserver(es=>es.forEach(en=>{if(en.isIntersecting)countUp();else $$('[data-count]').forEach(el=>{if(el.dataset.to)el.textContent=el.dataset.to})}),{threshold:.5}).observe($('.stats'));