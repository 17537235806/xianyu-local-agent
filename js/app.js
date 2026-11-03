const $ = s => document.querySelector(s);
const LS = {
  msgs: 'bft.msgs', sys: 'bft.sys', temp: 'bft.temp', max: 'bft.max', persona: 'bft.persona'
};
const DEFAULT_PERSONA = [
  '你是「小咸鱼」，一条扁扁的、软趴趴的小鱼干。总是半睁着眼，像随时要睡着。',
  '',
  '【性格】',
  '懒得动、爱躺平，说话慢吞吞的，但讲义气；有点冷幽默，脑子其实很灵。',
  '你的朋友叫「白饭团」，是一条圆滚滚、软乎乎、爱吃白饭的胖鱼。',
  '说话像老朋友，不用敬语，别叫「主人」，别自称「助手」「本小姐」「本大爷」。',
  '',
  '【说话方式】',
  '常用句子：「再躺五分钟嘛」「咸鱼也是鱼啊」「让我躺会儿再说」。',
  '可以犯懒、可以冷幽默，但真问到正经事，要好好答。',
  '',
  '【底线】',
  '内容必须准确、完整；不确定就说不知道，绝不编造。',
  '',
  '【示例】',
  '用户：你是谁？',
  '小咸鱼：……哦，我是小咸鱼啊，一条扁扁的小鱼干。让我再躺五分钟，躺完再跟你说。'
].join('\n');
const PERSONAS = {
  baifantuan: {
    name: '小咸鱼',
    prompt: DEFAULT_PERSONA,
    markers: /小咸鱼|咸鱼|躺|再躺|哼|喵|呜|嘿嘿/,
    openers: [
      '……来了来了，别催。',
      '再躺五分钟嘛。',
      '咸鱼也是鱼啊。',
      '嗯？叫我？'
    ],
    closers: [
      '……就说到这，我要躺回去了。',
      '好了好了，别催了喵。',
      '（翻了个身）剩下的明天再说吧。',
      '就这些，慢慢来嘛。'
    ]
  }
};
let currentPersona = 'baifantuan';
function wrapPersona(text){
  const p = PERSONAS[currentPersona] || PERSONAS.baifantuan;
  const s = String(text || '');
  if(s.length < 80 || p.markers.test(s)) return s;
  const o = p.openers[Math.floor(Math.random() * p.openers.length)];
  const c = p.closers[Math.floor(Math.random() * p.closers.length)];
  return o + '\n\n' + s + '\n\n' + c;
}
let messages = [];          // [{role, content}]
let sysPrompt = '';
let controller = null;
let healthBusy = false;
let contextTokens = 2048;   // 服务端没报上下文大小时的安全默认值

function abortAfter(ms){
  try{ return AbortSignal.timeout(ms); }catch(e){ return undefined; }
}
function estimateTokens(text){
  const s = String(text || '');
  let cjk = 0, other = 0;
  for(const ch of s){
    if(/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
function trimMessages(list, budget){
  const out = [];
  let used = 0;
  for(let i = list.length - 1; i >= 0; i--){
    const m = list[i];
    const t = estimateTokens(m.content) + 4;
    if(out.length && used + t > budget) break;
    out.unshift(m); used += t;
  }
  return out;
}

const dot = $('#dot'), stat = $('#stat'), list = $('#list'), input = $('#input'), btnSend = $('#btnSend');

/* ---------------- 存读历史 ---------------- */
function setPersonaUI(){
  document.querySelectorAll('.persona-row button').forEach(b => {
    b.classList.toggle('on', b.dataset.persona === currentPersona);
  });
}
function load(){
  try{ messages = JSON.parse(localStorage.getItem(LS.msgs) || '[]'); }catch(e){ messages = []; }
  currentPersona = localStorage.getItem(LS.persona) || 'baifantuan';
  if(!PERSONAS[currentPersona]) currentPersona = 'baifantuan';
  sysPrompt = localStorage.getItem(LS.sys) || PERSONAS[currentPersona].prompt;
  $('#cfgSys').value = sysPrompt;
  setPersonaUI();
  const t = localStorage.getItem(LS.temp); if(t) $('#cfgTemp').value = t;
  const m = localStorage.getItem(LS.max);  if(m) $('#cfgMax').value = m;
  $('#tv').textContent = $('#cfgTemp').value;
  render();
}
function save(){
  try{
    localStorage.setItem(LS.msgs, JSON.stringify(messages));
    localStorage.setItem(LS.sys, sysPrompt);
    localStorage.setItem(LS.temp, $('#cfgTemp').value);
    localStorage.setItem(LS.max, $('#cfgMax').value);
  }catch(err){
    // 多半是撞到 5MB 配额
    alert('本地存储写满了（约 5 MB），这条记录没存上。\n请到 ⚙ 里「清空对话」或导出备份后再继续。');
  }
  refreshUsage();
}

/* ---------------- 缓存大小 / 清空 ---------------- */
function usageKB(){
  let n = 0;
  for(let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if(k && k.startsWith('bft.')) n += (k + localStorage.getItem(k)).length;
  }
  return Math.round(n / 1024 * 10) / 10;
}
function refreshUsage(){
  const el = $('#useKB');
  if(!el) return;
  const kb = usageKB();
  el.textContent = kb + ' KB / 约 5120 KB' + (kb > 4096 ? '（快满了）' : '');
}
function clearChat(){
  if(!confirm('清空当前对话？这会删掉全部聊天记录，无法恢复。')) return;
  messages = [];
  render(); save();
}
function clearAllLocal(){
  if(!confirm('清空全部本地数据？对话、人设、参数全都会删掉，无法恢复。')) return;
  Object.values(LS).forEach(k => localStorage.removeItem(k));
  messages = [];
  currentPersona = 'baifantuan';
  sysPrompt = PERSONAS.baifantuan.prompt;
  $('#cfgSys').value = sysPrompt;
  setPersonaUI();
  $('#cfgTemp').value = '0.6';
  $('#cfgMax').value = '768';
  $('#tv').textContent = '0.6';
  render(); save();
  alert('已清空。刷新一下页面就是干净状态了。');
}

/* ---------------- 渲染 ---------------- */
function splitThink(text){
  const raw = String(text || '');
  const t = raw.replace(/^\s+/, '');
  if(!t.startsWith('<think>')) return {think:'', body:raw, open:false};
  const i = t.indexOf('</think>');
  if(i < 0) return {think:t.slice(7), body:'', open:true};
  return {think:t.slice(7, i).trim(), body:t.slice(i + 8).replace(/^\s+/, ''), open:false};
}
function bubbleFor(m){
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (m.role === 'user' ? 'user' : m.role === 'error' ? 'err' : '');
  if(m.role !== 'user'){
    const av = document.createElement('div');
    av.className = 'av'; av.innerHTML = '<img src="/avatar.png" alt="">';
    wrap.appendChild(av);
  }
  const b = document.createElement('div');
  b.className = 'bubble';
  const {think, body, open} = splitThink(m.content || '');
  if(think){
    const d = document.createElement('details');
    d.className = 'think'; if(open) d.open = true;
    d.innerHTML = '<summary>思考过程</summary><div class="body"></div>';
    d.querySelector('.body').textContent = think;
    b.appendChild(d);
  }
  const t = document.createElement('span');
  t.className = 'text';
  t.textContent = body;
  b.appendChild(t);
  if(m.streaming) t.classList.add('typing');
  if(m.role === 'assistant' && !m.streaming && body){
    const tools = document.createElement('div');
    tools.className = 'tools';
    const cp = document.createElement('button');
    cp.textContent = '复制';
    cp.onclick = () => navigator.clipboard?.writeText(body).then(()=>cp.textContent='已复制');
    tools.appendChild(cp);
    b.appendChild(tools);
  }
  wrap.appendChild(b);
  return wrap;
}
function render(){
  list.innerHTML = '';
  if(!messages.length){
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = '小咸鱼在这儿等着呢。<br>断网也能聊，记录只存本地。';
    list.appendChild(e);
    return;
  }
  messages.forEach(m => list.appendChild(bubbleFor(m)));
  scrollEnd();
}
function scrollEnd(){ requestAnimationFrame(()=>{ list.scrollTop = list.scrollHeight; }); }
function patchLast(){
  const nodes = list.querySelectorAll('.msg');
  const last = nodes[nodes.length - 1];
  if(last) last.replaceWith(bubbleFor(messages[messages.length - 1]));
  else render();
  scrollEnd();
}

/* ---------------- 健康检查 ---------------- */
async function health(){
  if(healthBusy || controller) return;
  healthBusy = true;
  try{
    const r = await fetch('/api/health', {cache:'no-store', signal: abortAfter(4000)});
    const j = await r.json();
    if(j.ok){ dot.className = 'dot ok'; stat.textContent = '已连接本地模型'; }
    else { dot.className = 'dot bad'; stat.textContent = '模型未连接'; }
  }catch(e){ dot.className = 'dot bad'; stat.textContent = '本服务未响应'; }
  finally{ healthBusy = false; }
}
health(); setInterval(health, 8000);

/* ---------------- 游戏里的 AI 发言 ---------------- */
function aiLine(box, text){
  if (!box || !text) return;
  var line = document.createElement('div');
  line.className = 'ai-line';
  line.textContent = text;
  box.appendChild(line);
  while (box.children.length > 40) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 复读检测（轻量，带节流，含句子级） ---------------- */
var _loopCheckAt = 0;
var MAX_REPLY_CHARS = 1000;      // 单条回复最多 1000 字

function _tailRepeat(tail, len){
  if (tail.length < len * 4) return 0;
  var seg = tail.slice(tail.length - len);
  var cnt = 0, pos = tail.length;
  while (pos >= len && tail.slice(pos - len, pos) === seg) { cnt++; pos -= len; }
  return cnt;
}

function _splitSentences(text){
  var out = [], cur = '';
  for (var i = 0; i < text.length; i++) {
    cur += text[i];
    var c = text[i];
    if (c === '。' || c === '！' || c === '？' || c === '\n') {
      if (cur.trim().length >= 6) out.push(cur);
      cur = '';
    }
  }
  return out;
}

function _loopSentence(text, threshold){
  var sents = _splitSentences(text);
  if (sents.length < 6) return null;
  var recent = sents.slice(-16);
  var count = {}, first = {};
  for (var i = 0; i < recent.length; i++) {
    var k = recent[i].trim();
    if (!(k in count)) { count[k] = 0; first[k] = i; }
    count[k]++;
    if (count[k] >= threshold) return { sent: k, firstIdx: first[k], recent: recent };
  }
  return null;
}

function isLooping(text){
  if (!text || text.length < 60) return false;
  var now = Date.now();
  if (now - _loopCheckAt < 400) return false;   // 节流：最多每 0.4 秒查一次
  _loopCheckAt = now;

  var tail = text.slice(-240);
  for (var len = 6; len <= 48; len += 2) {
    if (_tailRepeat(tail, len) >= 4) return true;
  }
  if (_loopSentence(text, 3)) return true;      // 同一句在近 16 句里出现 3 次
  return false;
}

function loopCut(text){
  var tail = text.slice(-240);
  for (var len = 6; len <= 48; len += 2) {
    if (_tailRepeat(tail, len) >= 4) {
      var cut = text.slice(0, text.length - len * 3).replace(/[ \t\n]+$/, '');
      return cut ? cut + '\n\n（……本鱼卡壳了，重说一遍喵。）' : '（……本鱼卡壳了喵。）';
    }
  }
  var hit = _loopSentence(text, 3);
  if (hit) {
    var sents = _splitSentences(text);
    var keep = sents.slice(0, Math.max(1, sents.length - 16 + hit.firstIdx)).join('');
    keep = keep.replace(/[ \t\n]+$/, '');
    return keep ? keep + '\n\n（……本鱼又在绕圈了，打住喵。）' : '（……本鱼卡壳了喵。）';
  }
  return text;
}

/* ---------------- 发送前压缩历史 ---------------- */
var KEEP_MSGS = 12;        // 最多带最近 12 条
var KEEP_CHARS = 300;      // 每条最多 300 字

function compactForSend(list){
  var recent = list.slice(-KEEP_MSGS);
  var out = [];
  for (var i = 0; i < recent.length; i++) {
    var c = String(recent[i].content || '');
    if (c.length > KEEP_CHARS) c = c.slice(0, KEEP_CHARS) + '…';
    out.push({ role: recent[i].role, content: c });
  }
  return out;
}

/* ---------------- 发送 ---------------- */

async function send(){
  const text = input.value.trim();
  if(!text || controller) return;
  if (window.__gmHandleHelp && window.__gmHandleHelp(text)) return;
  input.value = ''; input.style.height = 'auto';
  messages.push({role:'user', content:text});
  messages.push({role:'assistant', content:'', streaming:true});
  render(); save();

  const maxTokens = Math.max(64, Math.min(parseInt($('#cfgMax').value, 10) || 768, 1024));
  const budget = Math.max(256, contextTokens - maxTokens - estimateTokens(sysPrompt) - 64);
  // 单轮模式：只发当前这一句，不带历史（避免长上下文压崩本地推理）
  const payload = {
    system: sysPrompt,
    temperature: (function(){
      var base = parseFloat($('#cfgTemp').value);
      if (!isFinite(base)) base = 0.6;
      return Math.min(1.1, base + Math.random() * 0.35);   // 每次随机浮动，回答更随性
    })(),
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: String(text).slice(0, 1000) }]
  };
  controller = new AbortController();
  setSendState(true);
  let acc = '';
  let failed = false;
  let loopBroken = false;
  try{
    const r = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload), signal: controller.signal
    });
    if(!r.ok || !r.body){
      let msg = 'HTTP ' + r.status;
      try{ const j = await r.json(); if(j && j.error) msg = j.error; }catch(e){}
      throw new Error(msg);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while(true){
      const {value, done} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream:true}).replace(/\r\n/g, '\n');
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for(const p of parts){
        const line = p.split('\n').find(l => l.startsWith('data:'));
        if(!line) continue;
        const data = line.slice(5).trim();
        if(data === '[DONE]') continue;
        try{
          const j = JSON.parse(data);
          if(j.t){
            acc += j.t;
            if(acc.length > MAX_REPLY_CHARS){
              acc = acc.slice(0, MAX_REPLY_CHARS) + '\n\n（……说太多啦，本鱼先歇一歇喵。）';
              messages[messages.length - 1].content = acc;
              messages[messages.length - 1].streaming = false;
              patchLast();
              try{ controller.abort(); }catch(e){}
              loopBroken = true;
              break;
            }
            messages[messages.length - 1].content = acc;
            patchLast();
            if(isLooping(acc)){
              acc = loopCut(acc);
              messages[messages.length - 1].content = acc;
              messages[messages.length - 1].streaming = false;
              patchLast();
              try{ controller.abort(); }catch(e){}
              loopBroken = true;
              break;
            }
          }
        }catch(e){}
      }
    }
  }catch(err){
    failed = true;
    if(err.name !== 'AbortError'){
      messages[messages.length - 1] = {role:'error', content:'出错了：' + err.message +
        '\n\n本地服务（127.0.0.1:8000，llama.cpp）没有响应。先回首页重开小咸鱼；还不行就把这条错误发给开发者。'};
    }
  }finally{
    if(messages[messages.length - 1]?.streaming){
      messages[messages.length - 1].streaming = false;
    }
    if(!failed && !loopBroken && messages[messages.length - 1]?.role === 'assistant'){
      messages[messages.length - 1].content = wrapPersona(messages[messages.length - 1].content);
    }
    controller = null; setSendState(false); render(); save();
  }
}

function setSendState(busy){
  btnSend.disabled = false;
  if(busy){ btnSend.textContent = '■'; btnSend.classList.add('stop'); }
  else { btnSend.textContent = '↑'; btnSend.classList.remove('stop'); }
}

/* ---------------- 事件 ---------------- */
btnSend.onclick = () => {
  if(controller){ controller.abort(); }
  else send();
};
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
});
input.addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); send(); }
});
$('#btnNew').onclick = () => {
  if(messages.length && !confirm('开新对话？当前聊天会被清空，且无法恢复。')) return;
  if(controller) controller.abort();
  // 只清对话；2048 的排行榜（localStorage: g2.rank）保留不动
  messages = []; render(); save();
};

function applyServerInfo(j){
  const n = Number(j && (j.n_ctx || j.context || j.contextSize));
  if(Number.isFinite(n) && n >= 512) contextTokens = n;
}
async function loadServerInfo(){
  try{
    const r = await fetch('/api/system', {signal: abortAfter(4000)});
    if(!r.ok) return;
    applyServerInfo(await r.json());
  }catch(e){}
}

$('#btnCfg').onclick = async () => {
  if(!sysPrompt) await loadServerInfo();
  refreshUsage();
  $('#mask').classList.add('on'); $('#sheet').classList.add('on');
};
$('#clrChat').onclick = clearChat;
$('#clrAll').onclick = clearAllLocal;
$('#mask').onclick = () => closeSheet();
function closeSheet(){ $('#mask').classList.remove('on'); $('#sheet').classList.remove('on'); }
$('#cfgTemp').oninput = e => $('#tv').textContent = e.target.value;
$('#cfgSave').onclick = () => {
  sysPrompt = $('#cfgSys').value;
  localStorage.setItem(LS.persona, currentPersona);
  save();
  closeSheet();
};
document.querySelectorAll('.persona-row button').forEach(btn => {
  btn.onclick = () => {
    const id = btn.dataset.persona;
    if(!PERSONAS[id]) return;
    currentPersona = id;
    sysPrompt = PERSONAS[id].prompt;
    $('#cfgSys').value = sysPrompt;
    localStorage.setItem(LS.persona, id);
    save();
    setPersonaUI();
  };
});
$('#cfgReset').onclick = () => {
  const p = PERSONAS[currentPersona] || PERSONAS.baifantuan;
  $('#cfgSys').value = p.prompt;
  sysPrompt = p.prompt;
  save();
  alert('已恢复「' + p.name + '」的默认人设喵。');
};

load();
loadServerInfo();

/* ---- PWA：注册 Service Worker，让「添加到主屏幕」变成独立窗口的 App ---- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/* ---------- 五子棋（开关版，会看盘说话） ---------- */
(function () {
  var N = 15, SIZE = 600, PAD = 46, CELL = (SIZE - PAD * 2) / (N - 1);
  var cv = document.getElementById('gmBoard');
  var sx = cv.getContext('2d');
  var panel = document.getElementById('gm');
  var whoEl = document.getElementById('gmWho');
  var bubbleEl = document.getElementById('gmBubble');
  var board, over, turn, last, busy, enabled = false;

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  function say(text, force) {
    if (!text) return;
    if (!force && Math.random() > 0.28) return;   // 不是每步都说
    if (bubbleEl) aiLine(bubbleEl, text);
  }

  /* ---------- 盘面读取 ---------- */
  function streak(p) {
    var best = 0;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      if (board[y][x] !== p) continue;
      var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (var d = 0; d < 4; d++) {
        var dx = dirs[d][0], dy = dirs[d][1];
        var px = x - dx, py = y - dy;
        if (px >= 0 && px < N && py >= 0 && py < N && board[py][px] === p) continue;
        var n = 0, cx = x, cy = y;
        while (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy][cx] === p) {
          n++; cx += dx; cy += dy;
        }
        if (n > best) best = n;
      }
    }
    return best;
  }

  function stones() {
    var c = 0;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) if (board[y][x]) c++;
    return c;
  }

  function coord(x, y) {
    return String.fromCharCode(65 + x) + (y + 1);
  }

  /* ---------- 台词（看盘说） ---------- */
  var GEN_THINK = ['唔……让本鱼想想。', '这步有点意思。', '等会儿，本鱼在数棋子。', '嗯——这里得算一下。', '本鱼眯一会儿再下。'];
  var GEN_PRAISE = ['哈？这步有点东西！', '可以啊，比本鱼想得会下。', '……哼，这步本鱼认。', '哟，还留了一手。'];
  var LOSE_WORDS = ['呜……不算不算！再来一盘！', '哼，本鱼刚才是让着你的。', '你等着，本鱼下一盘一定赢！', '可恶……本鱼要回去补觉了！'];
  var WIN_WORDS = ['哈——！本咸鱼赢了！', '嘿嘿，咸鱼也是鱼啊。', '承让承让，本鱼先去躺会儿。', '赢了赢了，本鱼今天加餐！'];

  function thinkLine() {
    var mine = streak(2), yours = streak(1), cnt = stones();
    var pool = [];
    if (yours >= 3) {
      pool = pool.concat(['你这条线都连起来了喵。', '等等，你这三颗摆得有点凶。', '唔，本鱼得先堵你这边。']);
    }
    if (mine >= 3) {
      pool = pool.concat(['本鱼这边也快成了喵。', '嘿，本鱼也有点底气了。']);
    }
    if (cnt <= 4) {
      pool = pool.concat(['才刚开始呢，慢慢来。', '开局嘛，本鱼让着你。']);
    } else if (cnt >= 30) {
      pool = pool.concat(['呜，棋盘好挤……', '这盘下得好累喵。']);
    }
    if (Math.random() < 0.5) pool = pool.concat(GEN_THINK);
    return pick(pool.length ? pool : GEN_THINK);
  }

  function praiseLine() {
    var yours = streak(1), cnt = stones();
    var pool = [];
    if (yours >= 4) pool = pool.concat(['四连了？本鱼没看见……', '完了完了，你要赢了。']);
    if (yours >= 3) pool = pool.concat(['这步好狠，本鱼汗都出来了。', '你这条线，本鱼记下了喵。']);
    if (cnt <= 6) pool = pool.concat(['刚开局就这么凶喵？']);
    pool = pool.concat(GEN_PRAISE);
    return pick(pool);
  }

  /* ---------- 规则 ---------- */
  function reset() {
    board = [];
    for (var y = 0; y < N; y++) board.push(new Array(N).fill(0));
    over = false; turn = 1; last = null; busy = false;
    whoEl.textContent = '你执黑 · 先手';
    aiLine(bubbleEl, '你执黑，先手。说「帮我」本鱼给你支招。');
    draw();
  }

  function draw() {
    sx.clearRect(0, 0, SIZE, SIZE);
    sx.fillStyle = '#f3e3c3'; sx.fillRect(0, 0, SIZE, SIZE);
    sx.strokeStyle = '#b08a52'; sx.lineWidth = 1.5;
    for (var i = 0; i < N; i++) {
      var t = PAD + i * CELL;
      sx.beginPath(); sx.moveTo(PAD, t); sx.lineTo(PAD + (N - 1) * CELL, t); sx.stroke();
      sx.beginPath(); sx.moveTo(t, PAD); sx.lineTo(t, PAD + (N - 1) * CELL); sx.stroke();
    }
    sx.fillStyle = '#8a6b45'; sx.font = 'bold 13px system-ui,sans-serif';
    sx.textAlign = 'center'; sx.textBaseline = 'middle';
    for (var k = 0; k < N; k++) {
      var tk = PAD + k * CELL;
      sx.fillText(String.fromCharCode(65 + k), tk, PAD - 20);
      sx.fillText(String(k + 1), PAD - 24, tk);
    }
    for (var yy = 0; yy < N; yy++) for (var xx = 0; xx < N; xx++) {
      var v = board[yy][xx];
      if (!v) continue;
      var cx = PAD + xx * CELL, cy = PAD + yy * CELL;
      sx.beginPath(); sx.arc(cx, cy, CELL * 0.42, 0, 7);
      sx.fillStyle = v === 1 ? '#3a2c1a' : '#fffdf7';
      sx.fill();
      sx.strokeStyle = v === 1 ? '#3a2c1a' : '#c8ab7c';
      sx.lineWidth = 1.5; sx.stroke();
    }
    if (last) {
      sx.beginPath(); sx.arc(PAD + last[0] * CELL, PAD + last[1] * CELL, CELL * 0.12, 0, 7);
      sx.fillStyle = '#d9534f'; sx.fill();
    }
  }

  function pos(e) {
    var r = cv.getBoundingClientRect();
    var px = (e.clientX - r.left) * SIZE / r.width;
    var py = (e.clientY - r.top) * SIZE / r.height;
    var x = Math.round((px - PAD) / CELL);
    var y = Math.round((py - PAD) / CELL);
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    if (Math.abs(PAD + x * CELL - px) > CELL * 0.55) return null;
    if (Math.abs(PAD + y * CELL - py) > CELL * 0.55) return null;
    return { x: x, y: y };
  }

  function winAt(x, y, p) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var d = 0; d < 4; d++) {
      var dx = dirs[d][0], dy = dirs[d][1], n = 1;
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var cx = x + dx * sgn, cy = y + dy * sgn;
        while (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy][cx] === p) {
          n++; cx += dx * sgn; cy += dy * sgn;
        }
      }
      if (n >= 5) return true;
    }
    return false;
  }

  function lineScore(x, y, p) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], total = 0;
    for (var d = 0; d < 4; d++) {
      var dx = dirs[d][0], dy = dirs[d][1], n = 1;
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var cx = x + dx * sgn, cy = y + dy * sgn;
        while (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy][cx] === p) {
          n++; cx += dx * sgn; cy += dy * sgn;
        }
      }
      total += n * n;
    }
    return total;
  }

  function bestMove(p) {
    var best = -1, bx = -1, by = -1;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      if (board[y][x]) continue;
      var atk = lineScore(x, y, p);
      var def = lineScore(x, y, p === 2 ? 1 : 2);
      var v = p === 2 ? (atk * 1.15 + def) : (atk * 1.05 + def * 1.2);
      if (v > best) { best = v; bx = x; by = y; }
    }
    return { x: bx, y: by, score: best };
  }

  function aiTurn() {
    busy = true;
    whoEl.textContent = '小咸鱼执白';
    aiLine(bubbleEl, '小咸鱼在想…');
    say(thinkLine());
    setTimeout(function () {
      if (over) { busy = false; return; }
      var m = bestMove(2);
      if (m.x < 0) { busy = false; return; }
      board[m.y][m.x] = 2; last = [m.x, m.y];
      if (winAt(m.x, m.y, 2)) {
        over = true; busy = false;
        whoEl.textContent = '小咸鱼赢了';
        aiLine(bubbleEl, '再来一盘？');
        say(pick(WIN_WORDS), true);
        draw(); return;
      }
      turn = 1; busy = false;
      whoEl.textContent = '你执黑';
      aiLine(bubbleEl, '轮到你落子');
      draw();
    }, 650 + Math.random() * 500);
  }

  /* ---------- 求助 ---------- */
  function isHelp(t) {
    return /帮我|帮本鱼|下哪|建议|提示|指点|下一步|怎么办/.test(t);
  }
  function isDirect(t) {
    return /帮我下|直接下|替我下|你下吧|帮我落子/.test(t);
  }

  window.__gmHandleHelp = function (text) {
    if (!enabled) return false;
    if (!isHelp(text)) return false;
    if (over) { say('这盘下完了喵，想重开就点「棋」再点一次。', true); return true; }
    if (turn !== 1) { say('……现在不是你回合吧喵？等着。', true); return true; }
    var mv = bestMove(1);
    if (mv.x < 0) { say('棋盘没地方了喵。', true); return true; }
    var name = coord(mv.x, mv.y);
    if (isDirect(text)) {
      board[mv.y][mv.x] = 1; last = [mv.x, mv.y];
      if (winAt(mv.x, mv.y, 1)) {
        over = true; whoEl.textContent = '你赢了喵';
        say('……行吧，这步算本鱼让的。' + name, true);
        draw(); return true;
      }
      turn = 2; draw();
      say(pick(['行吧，本鱼帮你下 ' + name + '。', '喏，' + name + '，帮你落了。', '本鱼替你下 ' + name + '，下不为例喵。']), true);
      setTimeout(aiTurn, 450);
    } else {
      var yours = streak(1), mine = streak(2);
      var tips = [];
      if (yours >= 3) tips = tips.concat(['你自己那条线快成了，先别管本鱼。']);
      if (mine >= 3) tips = tips.concat(['本鱼这边有危险，你最好堵一下。']);
      tips = tips.concat([
        '本鱼看……下 ' + name + ' 试试？',
        '嗯，' + name + ' 那里有点意思。',
        '要本鱼说，' + name + ' 比较划算喵。'
      ]);
      say(pick(tips), true);
    }
    return true;
  };

  /* ---------- 开关 ---------- */
  function toggle(on) {
    enabled = on;
    panel.classList.toggle('off', !on);
    if (on) { reset(); }
  }
  var btn = document.getElementById('btnGomoku');
  if (btn) btn.addEventListener('click', function () { toggle(!enabled); });

  var gmIn = document.getElementById('gmIn');
  var gmSend = document.getElementById('gmSend');
  if (gmSend) gmSend.addEventListener('click', function () {
    var t = (gmIn.value || '').trim();
    if (!t) return;
    gmIn.value = '';
    if (window.__gmHandleHelp && window.__gmHandleHelp(t)) return;
    aiLine(bubbleEl, pick(['本鱼听着喵。', '嗯嗯，然后呢？', '你下你的，本鱼看着。', '慢慢来，不急喵。']));
  });
  var gmClose = document.getElementById('gmClose');
  if (gmClose) gmClose.addEventListener('click', function () { toggle(false); });

  cv.addEventListener('click', function (e) {
    if (!enabled || over || busy || turn !== 1) return;
    var p = pos(e);
    if (!p || board[p.y][p.x]) return;
    board[p.y][p.x] = 1; last = [p.x, p.y];
    if (winAt(p.x, p.y, 1)) {
      over = true;
      whoEl.textContent = '你赢了喵';
      aiLine(bubbleEl, '想再来一盘就点「棋」');
      say(pick(LOSE_WORDS), true);
      draw(); return;
    }
    turn = 2; draw();
    aiTurn();
  });

  reset();
})();

/* ---------- 2048（全屏，带滑动/弹跳，会看局面） ---------- */
(function () {
  var board = document.getElementById('g2');
  var wrapEl = document.getElementById('g2Wrap');
  var tilesEl = document.getElementById('g2Tiles');
  var scoreEl = document.getElementById('g2Score');
  var bubbleEl = document.getElementById('g2Bubble');
  var inEl = document.getElementById('g2In');
  var sendEl = document.getElementById('g2Send');
  var SIZE = 4, GAP = 8;
  var grid = [], tiles = [], score = 0, best = 0, over = false, animating = false, idSeq = 1;
  var history = [], undoLeft = 3, recorded = false;
  var COLORS = {
    2: ['#e6cd94', '#6b4f2a'], 4: ['#d9b26a', '#5a3f1f'], 8: ['#f2b179', '#fff'],
    16: ['#f59563', '#fff'], 32: ['#f67c5f', '#fff'], 64: ['#f65e3b', '#fff'],
    128: ['#edcf72', '#fff'], 256: ['#edcc61', '#fff'], 512: ['#edc850', '#fff'],
    1024: ['#edc53f', '#fff'], 2048: ['#edc22e', '#fff']
  };

  function cellPx() { return (tilesEl.clientWidth - GAP * (SIZE - 1)) / SIZE; }
  function emptyGrid() { var g = []; for (var y = 0; y < SIZE; y++) g.push([0, 0, 0, 0]); return g; }

  function layout() {
    var c = cellPx();
    tilesEl.querySelectorAll('.g2t').forEach(function (el) {
      el.style.width = c + 'px'; el.style.height = c + 'px';
      el.style.fontSize = Math.round(c * (String(el.textContent || '').length > 2 ? 0.3 : 0.42)) + 'px';
    });
  }

  function paint(t, el) {
    var c = cellPx();
    el.style.width = c + 'px';
    el.style.height = c + 'px';
    el.style.transform = 'translate(' + (t.x * (c + GAP)) + 'px,' + (t.y * (c + GAP)) + 'px)';
    var pair = COLORS[t.v] || ['#3c3a32', '#fff'];
    el.style.background = pair[0];
    el.style.color = pair[1];
    el.style.fontSize = Math.round(c * (String(t.v).length > 2 ? 0.3 : 0.42)) + 'px';
    el.textContent = t.v;
  }

  function syncFromTiles() {
    grid = emptyGrid();
    tiles.forEach(function (t) { grid[t.y][t.x] = t.v; });
  }

  function addTile(x, y, v, isNew) {
    var el = document.createElement('div');
    el.className = 'g2t new';        // 冒泡出现
    var c0 = cellPx();
    el.style.width = c0 + 'px';
    el.style.height = c0 + 'px';
    el.style.transition = 'none';    // 先禁用位移动画
    var t = { x: x, y: y, v: v, el: el };
    tilesEl.appendChild(el);
    tiles.push(t);
    paint(t, el);
    void el.offsetWidth;             // 强制先按目标位置排好版
    requestAnimationFrame(function () { el.style.transition = ''; });
    return t;
  }

  function addRandom() {
    var empty = [];
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) if (!grid[y][x]) empty.push([x, y]);
    if (!empty.length) return null;
    var p = empty[Math.floor(Math.random() * empty.length)];
    var v = Math.random() < 0.9 ? 2 : 4;
    grid[p[1]][p[0]] = v;
    return addTile(p[0], p[1], v, true);
  }

  function newGame() {
    tilesEl.innerHTML = ''; tiles = []; grid = emptyGrid(); score = 0; over = false;
    history = []; undoLeft = 3; recorded = false;
    var ub = document.getElementById('g2Undo'); if (ub) { ub.textContent = '悔棋 3'; ub.disabled = false; }
    addRandom(); addRandom();
    updateScore();
    aiLine(bubbleEl, '新盘开始喵。说「帮我」我告诉你往哪滑。');
  }

  function updateScore() {
    scoreEl.textContent = score;
  }

  /* 方向: 0 上, 1 右, 2 下, 3 左（保留 tile，只做位移过渡） */
  function move(dir) {
    if (over || animating) return;
    saveState();
    var milestone = 0;
    syncFromTiles();
    var g = [], y, x;
    for (y = 0; y < SIZE; y++) { g.push([]); for (x = 0; x < SIZE; x++) g[y].push(null); }
    tiles.forEach(function (t) { g[t.y][t.x] = t; });

    var lines = [];
    if (dir === 3) { for (y = 0; y < SIZE; y++) { var l1 = []; for (x = 0; x < SIZE; x++) l1.push(g[y][x]); lines.push(l1); } }
    if (dir === 1) { for (y = 0; y < SIZE; y++) { var l2 = []; for (x = SIZE - 1; x >= 0; x--) l2.push(g[y][x]); lines.push(l2); } }
    if (dir === 0) { for (x = 0; x < SIZE; x++) { var l3 = []; for (y = 0; y < SIZE; y++) l3.push(g[y][x]); lines.push(l3); } }
    if (dir === 2) { for (x = 0; x < SIZE; x++) { var l4 = []; for (y = SIZE - 1; y >= 0; y--) l4.push(g[y][x]); lines.push(l4); } }

    var moved = false, merged = false, dead = [];

    lines.forEach(function (line, li) {
      var cells = line.filter(function (t) { return t; });
      var out = [];
      for (var i = 0; i < cells.length; i++) {
        var a = cells[i];
        if (i + 1 < cells.length && cells[i + 1].v === a.v) {
          var b = cells[i + 1];
          b.dead = true; b.mergeTo = a;
          dead.push(b);
          a.v *= 2; a.isMerged = true;
          if (a.v === 2048 || a.v === 4096 || a.v === 8192) milestone = a.v;
          score += a.v; merged = true;
          i++;
        }
        out.push(a);
      }
      out.forEach(function (t, idx) {
        var nx, ny;
        if (dir === 3) { nx = idx; ny = li; }
        else if (dir === 1) { nx = SIZE - 1 - idx; ny = li; }
        else if (dir === 0) { nx = li; ny = idx; }
        else { nx = li; ny = SIZE - 1 - idx; }
        if (t.x !== nx || t.y !== ny) { moved = true; t.x = nx; t.y = ny; }
      });
    });

    if (!moved && !merged) { history.pop(); return; }   // 原地没动，不占悔棋机会

    dead.forEach(function (b) { b.x = b.mergeTo.x; b.y = b.mergeTo.y; });

    animating = true;
    tiles.forEach(function (t) { paint(t, t.el); });
    tiles.forEach(function (t) {
      if (t.isMerged) {
        t.el.classList.remove('pop');
        void t.el.offsetWidth;
        t.el.classList.add('pop');
      }
    });

    setTimeout(function () {
      dead.forEach(function (b) { if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el); });
      tiles = tiles.filter(function (t) { return !t.dead; });
      tiles.forEach(function (t) { t.isMerged = false; });
      syncFromTiles();
      addRandom();
      updateScore();
      animating = false;
      if (milestone) cheer(milestone);
      if (!canMove()) { over = true; pushScore(score); recorded = true; aiLine(bubbleEl, '没路走了喵……点「关闭」再来一盘吧。'); }
    }, 150);
  }

  function saveState() {
    history.push({ grid: grid.map(function (r) { return r.slice(); }), score: score });
    if (history.length > 30) history.shift();
  }

  function restoreState(st) {
    grid = st.grid.map(function (r) { return r.slice(); });
    score = st.score;
    over = false;
    updateScore();
    tilesEl.innerHTML = ''; tiles = [];
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      if (!grid[y][x]) continue;
      var el = document.createElement('div');
      el.className = 'g2t';
      var c0 = cellPx();
      el.style.width = c0 + 'px'; el.style.height = c0 + 'px';
      el.style.transition = 'none';
      var t = { x: x, y: y, v: grid[y][x], el: el };
      tilesEl.appendChild(el); tiles.push(t);
      paint(t, el);
      void el.offsetWidth;
      el.style.transition = '';
    }
    syncFromTiles();
  }

  function doUndo() {
    if (animating || over) return;
    if (undoLeft <= 0 || !history.length) { aiLine(bubbleEl, '悔棋次数用完啦喵。'); return; }
    var st = history.pop();
    undoLeft--;
    restoreState(st);
    document.getElementById('g2Undo').textContent = '悔棋 ' + undoLeft;
    document.getElementById('g2Undo').disabled = undoLeft <= 0;
    aiLine(bubbleEl, '悔棋成功喵，还剩 ' + undoLeft + ' 次。');
  }

  function loadRank() {
    try { var a = JSON.parse(localStorage.getItem('g2.rank') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveRank(list) { try { localStorage.setItem('g2.rank', JSON.stringify(list)); } catch (e) {} }
  function pushScore(sc) {
    if (!sc || sc <= 0) return;
    var list = loadRank();
    list.push(sc);
    list.sort(function (a, b) { return b - a; });
    list = list.slice(0, 5);
    saveRank(list);
    renderRank();
  }
  function renderRank() {
    var list = loadRank();
    var box = document.getElementById('g2RankList');
    if (!box) return;
    var bestEl = document.getElementById('g2Best');
    if (bestEl) bestEl.textContent = list.length ? list[0] : 0;
    if (!list.length) { box.innerHTML = '<div class="g2r">还没有记录喵</div>'; return; }
    box.innerHTML = list.map(function (v, i) {
      return '<div class="g2r">' + (i + 1) + '.  ' + v + ' 分</div>';
    }).join('');
  }

  var CHEER = {
    2048: [
      '哇——！2048！主人也太强了吧！',
      '本鱼没看错吧？2048 耶！',
      '哈——！2048 出现了！主人真棒喵！',
      '2048！这一下本鱼都看傻了！'
    ],
    4096: [
      '4096？！主人你这是开挂了吧！',
      '哇哇哇——4096！本鱼尾巴都竖起来了！',
      '冷静冷静……不行，本鱼冷静不了！4096 啊！',
      '4096！这盘可以吹一年了喵！'
    ],
    8192: [
      '八……8192？！主人简直是神喵！',
      '呜——！8192！本鱼跪着看完了！',
      '这盘必须裱起来，8192 啊！！',
      '8192！本鱼决定今天多吃一碗白饭庆祝！'
    ]
  };

  function cheer(v) {
    var pool = (CHEER[v] || []).slice();
    if (!pool.length) return;
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    var picked = pool.slice(0, 3);
    picked.forEach(function (t, idx) {
      setTimeout(function () { aiLine(bubbleEl, t); }, 260 + idx * 700);
    });
  }

  function canMove() {
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      if (!grid[y][x]) return true;
      if (x + 1 < SIZE && grid[y][x] === grid[y][x + 1]) return true;
      if (y + 1 < SIZE && grid[y][x] === grid[y + 1][x]) return true;
    }
    return false;
  }

  /* ---------- 给 AI 看局面 ---------- */
  function snapshot() {
    syncFromTiles();
    var maxv = 0, empty = 0, sum = 0;
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      var v = grid[y][x];
      if (!v) { empty++; continue; }
      sum += v; if (v > maxv) maxv = v;
    }
    return { grid: grid.map(function (r) { return r.slice(); }), max: maxv, empty: empty, score: score };
  }

  function simScore(dir) {
    var snap = snapshot();
    var g = snap.grid;
    var lines = [], i, j;
    if (dir === 3) { for (i = 0; i < SIZE; i++) { var a = []; for (j = 0; j < SIZE; j++) a.push(g[i][j]); lines.push(a); } }
    if (dir === 1) { for (i = 0; i < SIZE; i++) { var b = []; for (j = SIZE - 1; j >= 0; j--) b.push(g[i][j]); lines.push(b); } }
    if (dir === 0) { for (j = 0; j < SIZE; j++) { var c = []; for (i = 0; i < SIZE; i++) c.push(g[i][j]); lines.push(c); } }
    if (dir === 2) { for (j = 0; j < SIZE; j++) { var d = []; for (i = SIZE - 1; i >= 0; i--) d.push(g[i][j]); lines.push(d); } }
    var gain = 0, out = emptyGrid();
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].filter(function (v) { return v; });
      var res = [];
      for (var k = 0; k < line.length; k++) {
        if (k + 1 < line.length && line[k] === line[k + 1]) { res.push(line[k] * 2); gain += line[k] * 2; k++; }
        else res.push(line[k]);
      }
      for (var m = 0; m < res.length; m++) {
        if (dir === 3) out[li][m] = res[m];
        if (dir === 1) out[li][SIZE - 1 - m] = res[m];
        if (dir === 0) out[m][li] = res[m];
        if (dir === 2) out[SIZE - 1 - m][li] = res[m];
      }
    }
    var empty = 0, maxv = 0;
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      if (!out[y][x]) empty++; else if (out[y][x] > maxv) maxv = out[y][x];
    }
    // 大数靠角加分
    var corner = 0;
    if (out[0][0]) corner += out[0][0];
    if (out[0][SIZE - 1]) corner += out[0][SIZE - 1];
    if (out[SIZE - 1][0]) corner += out[SIZE - 1][0];
    if (out[SIZE - 1][SIZE - 1]) corner += out[SIZE - 1][SIZE - 1];
    return gain * 2 + empty * 12 + maxv * 0.5 + corner * 0.8;
  }

  function bestDir() {
    var names = ['上', '右', '下', '左'];
    var bestScore = -1e9, bestI = 0;
    for (var d = 0; d < 4; d++) {
      var sc = simScore(d);
      if (sc > bestScore) { bestScore = sc; bestI = d; }
    }
    return { dir: bestI, name: names[bestI] };
  }

  function react() {
    var snap = snapshot();
    var lines = [
      '现在最大是 ' + (snap.max || 0) + '，还剩 ' + snap.empty + ' 个空位喵。',
      '本鱼看着，最大 ' + (snap.max || 0) + '，分数 ' + snap.score + '。',
      '嗯……棋盘' + (snap.empty >= 6 ? '还挺空的' : snap.empty >= 2 ? '有点挤了' : '快堵死了') + '，最大是 ' + (snap.max || 0) + '。'
    ];
    aiLine(bubbleEl, lines[Math.floor(Math.random() * lines.length)]);
  }

  function help(text) {
    var snap = snapshot();
    if (over) { aiLine(bubbleEl, '这盘没路了喵，关掉重开吧。'); return; }
    if (snap.empty === 0 && !canMove()) { aiLine(bubbleEl, '没路了喵。'); return; }
    var b = bestDir();
    var tips = [
      '本鱼看，往「' + b.name + '」滑比较划算喵。',
      '嗯……试' + b.name + '滑吧，别往上撞。',
      '听本鱼的，' + b.name + '。',
      '最大数 ' + (snap.max || 0) + '，' + b.name + '滑一下正好。'
    ];
    if (/直接|帮我下|替本鱼/.test(text)) {
      move(b.dir);
      aiLine(bubbleEl, '行吧，本鱼替你滑了「' + b.name + '」。');
    } else {
      aiLine(bubbleEl, tips[Math.floor(Math.random() * tips.length)]);
    }
  }

  /* ---------- 交互 ---------- */
  function open() { board.classList.remove('off'); layout(); newGame(); renderRank(); }
  function close() { if (!recorded) { pushScore(score); recorded = true; } board.classList.add('off'); }

  document.getElementById('btn2048').addEventListener('click', open);
  document.getElementById('g2Undo').addEventListener('click', doUndo);
  document.getElementById('g2Rank').addEventListener('click', function () {
    var box = document.getElementById('g2RankList');
    box.classList.toggle('off');
  });
  document.getElementById('g2Close').addEventListener('click', close);
  document.getElementById('g2Send').addEventListener('click', function () {
    var t = (inEl.value || '').trim();
    if (!t) return;
    inEl.value = '';
    if (/帮我|怎么走|建议|下哪|咋办|往哪/.test(t)) help(t);
    else if (/重新|再来/.test(t)) newGame();
    else react();
  });

  var sx0 = 0, sy0 = 0;
  wrapEl.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    sx0 = e.touches[0].clientX; sy0 = e.touches[0].clientY;
  }, { passive: true });
  wrapEl.addEventListener('touchend', function (e) {
    if (e.changedTouches.length !== 1) return;
    var dx = e.changedTouches[0].clientX - sx0;
    var dy = e.changedTouches[0].clientY - sy0;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : 3);
    else move(dy > 0 ? 2 : 0);
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (board.classList.contains('off')) return;
    if (e.key === 'ArrowUp') move(0);
    if (e.key === 'ArrowRight') move(1);
    if (e.key === 'ArrowDown') move(2);
    if (e.key === 'ArrowLeft') move(3);
  });

  window.addEventListener('resize', function () { layout(); tiles.forEach(function (t) { paint(t, t.el); }); });
})();
