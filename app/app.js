'use strict';

const $ = (sel) => document.querySelector(sel);
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const FIELD_ORDER = ['훈음', '뜻', '예문', '유의어', '고유어 대응', '한자어 대응', '참고'];
const SEARCH_FIELDS = ['뜻', '예문', '유의어', '고유어 대응', '한자어 대응', '훈음', '참고'];

const state = { q: '', kind: '', topic: 0, open: new Set() };
let DATA = null;

// ── 유틸 ──────────────────────────────────────────────
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function chosung(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return out;
}
const isChosungQuery = (q) => /^[ㄱ-ㅎ]+$/.test(q);

/** 텍스트에서 [start, end) 구간을 <mark>로 감싼 HTML을 만든다. */
function markRange(text, start, end) {
  if (start < 0) return esc(text);
  return esc(text.slice(0, start)) + '<mark>' + esc(text.slice(start, end)) + '</mark>' + esc(text.slice(end));
}
function markAll(text, q) {
  if (!q) return esc(text);
  const parts = text.split(q);
  return parts.map(esc).join('<mark>' + esc(q) + '</mark>');
}

// ── 검색 ──────────────────────────────────────────────
function matchScore(w, q) {
  if (!q) return 1;
  if (isChosungQuery(q)) {
    const i = chosung(w.word).indexOf(q);
    return i < 0 ? 0 : (i === 0 ? 100 : 80);
  }
  if (w.word === q) return 200;
  if (w.word.startsWith(q)) return 150;
  if (w.word.includes(q)) return 120;
  if (w.hanja && w.hanja.includes(q)) return 110;
  for (const f of SEARCH_FIELDS) {
    const v = w.fields[f];
    if (v && v.includes(q)) return f === '뜻' ? 60 : f === '유의어' || f.endsWith('대응') ? 50 : 30;
  }
  return 0;
}

function filtered() {
  const q = state.q.trim();
  return DATA.words
    .filter((w) => (!state.kind || (state.kind === 'mine' ? w.custom : w.kind === state.kind)) && (!state.topic || w.topic === state.topic))
    .map((w) => ({ w, s: matchScore(w, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.w);
}

// ── 렌더링 ────────────────────────────────────────────
function wordHTML(w, q) {
  if (q && isChosungQuery(q)) {
    const i = chosung(w.word).indexOf(q);
    return markRange(w.word, i, i + q.length);
  }
  return markAll(w.word, q);
}

// ── 본문 속 표제어 링크 ────────────────────────────────
// 표제어는 그대로, '-하다' 말은 어간 뒤에 하/한/할/함/해/히/했이 올 때, 다른 용언은 '다'를 뺀 어간으로 찾는다.
// 다른 낱말 속에 들어 있는 경우(예: '동정적' 속 '정적')는 앞 글자가 한글이면 건너뛴다.
const HA_ENDINGS = '하한할함해히했';
const LINK_STOP = new Set(['이내']); // 본문에서는 부사 '이내'(곧)와 헷갈려 링크하지 않는다(유의어·대응어 목록에서는 링크)
const LINK_SKIP = ['주저앉']; // 표제어로 시작하지만 다른 낱말인 합성어
let LINK_FORMS = [];
function buildLinkForms() {
  const forms = [];
  for (const w of DATA.words) {
    if (LINK_STOP.has(w.word)) { forms.push({ form: w.word, w, listOnly: true }); continue; }
    if (w.word.endsWith('하다')) forms.push({ form: w.word.slice(0, -2), w, ha: true, inflect: true });
    else if (w.word.endsWith('다') && /사$/.test(w.pos) && w.word.length >= 3) forms.push({ form: w.word.slice(0, -1), w, inflect: true });
    else forms.push({ form: w.word, w });
  }
  LINK_FORMS = forms.sort((a, b) => b.form.length - a.form.length);
}
const isHangul = (ch) => ch >= '가' && ch <= '힣';

/** 글 속의 사전 표제어를 찾아 링크로 바꾼 HTML을 만든다(검색어 강조 포함). isList: 유의어·대응어 목록 칸 */
function linkText(text, selfId, q, isList = false) {
  let out = '', plain = '', i = 0;
  while (i < text.length) {
    let hit = null;
    if (!isHangul(text[i - 1] || '') && !LINK_SKIP.some((x) => text.startsWith(x, i))) {
      hit = LINK_FORMS.find(({ form, w, ha, listOnly }) => w.id !== selfId && (isList || !listOnly) && text.startsWith(form, i)
        && (!ha || HA_ENDINGS.includes(text[i + form.length] || '')));
    }
    if (hit) {
      // 용언은 활용 어미까지(예: '괴괴함', '수척해져') 한 낱말로 링크한다.
      let end = i + hit.form.length;
      if (hit.inflect) while (end < text.length && isHangul(text[end])) end += 1;
      out += markAll(plain, q); plain = '';
      out += `<a class="xref" href="#w=${hit.w.id}" data-go="${hit.w.id}">${markAll(text.slice(i, end), q)}</a>`;
      i = end;
    } else { plain += text[i]; i += 1; }
  }
  return out + markAll(plain, q);
}

function sensesHTML(text, selfId, q) {
  const parts = text.split(/\s(?=[①②③④⑤⑥⑦⑧⑨⑩])/);
  if (parts.length === 1) return linkText(text, selfId, q);
  return '<ol class="senses">' + parts.map((p) => `<li>${linkText(p, selfId, q)}</li>`).join('') + '</ol>';
}

function detailHTML(w, q) {
  const rows = FIELD_ORDER.filter((f) => w.fields[f]).map((f) => {
    const v = w.fields[f];
    let body;
    if (f === '뜻') body = sensesHTML(v, w.id, q);
    else if (f === '예문') body = `<div class="ex">${linkText(v, w.id, q)}</div>`;
    else if (f === '훈음') body = markAll(v, q);
    else body = linkText(v, w.id, q, f === '유의어' || f.endsWith('대응'));
    return `<dt>${f}</dt><dd>${body}</dd>`;
  }).join('');
  const t = DATA.topics.find((t) => t.kind === w.kind && t.no === w.topic);
  const mine = w.custom ? `<button class="del" type="button" data-del-custom="${w.id}">내 단어에서 삭제</button>` : '';
  return `<div class="detail"><dl>${rows}</dl><div class="detail-foot"><span class="topic">${w.kind} · ${t.no}. ${esc(t.name)}${w.custom ? ` · 내 단어(${esc(w.added || '')})` : ''}</span>${mine}<button class="ask" type="button" data-ask="${w.id}">✦ Claude에게 묻기</button></div></div>`;
}

function gist(w) {
  return w.fields['뜻'].split(/\s(?=[②③④⑤⑥⑦⑧⑨⑩])/)[0].replace(/^①\s*/, '');
}

function cardHTML(w, q) {
  const open = state.open.has(w.id);
  const kindCls = w.kind === '한자어' ? 'h' : 'g';
  return `<article class="card" id="${w.id}" ${open ? 'data-open' : ''}>
    <button aria-expanded="${open}" aria-controls="${w.id}-d" data-toggle="${w.id}">
      <div class="head">
        <span class="word">${wordHTML(w, q)}</span>
        ${w.hanja ? `<span class="hj">${markAll(w.hanja, q)}</span>` : ''}
        <span class="pos">${w.pos}</span>
        ${w.custom ? '<span class="kind u">내 단어</span>' : ''}<span class="kind ${kindCls}">${w.kind}</span>
      </div>
      <p class="gist">${esc(gist(w))}</p>
    </button>
    <div id="${w.id}-d" ${open ? '' : 'hidden'}>${open ? detailHTML(w, q) : ''}</div>
  </article>`;
}

function renderToday() {
  const el = $('#today');
  if (state.q || state.kind || state.topic) { el.hidden = true; return; }
  const d = new Date();
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  const w = DATA.words[day % DATA.words.length];
  el.innerHTML = `<div class="label">오늘의 단어</div>
    <div class="w">${esc(w.word)}${w.hanja ? `<span class="hj">${esc(w.hanja)}</span>` : ''}</div>
    <p>${esc(gist(w))}</p>
    <p class="ex">${esc(w.fields['예문'])}</p>
    <button data-go="${w.id}">자세히 보기 →</button>`;
  el.hidden = false;
}

function renderIntro() {
  const el = $('#intro');
  if (!state.topic) { el.hidden = true; return; }
  const ts = DATA.topics.filter((t) => t.no === state.topic && (!state.kind || t.kind === state.kind));
  el.innerHTML = ts.map((t) => `<p><b>${t.kind}</b>${esc(t.intro)}</p>`).join('');
  el.hidden = false;
}

function renderMineBar() {
  const el = $('#mine-bar');
  el.hidden = state.kind !== 'mine';
  if (el.hidden) $('#mine-export-text').hidden = true;
  $('#mine-export').disabled = !DATA.words.some((w) => w.custom);
}

function renderControls() {
  document.querySelectorAll('#kinds button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.kind === state.kind)));
  document.querySelectorAll('#topics .chip').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.topic) === state.topic)));
  if ($('#q').value !== state.q) $('#q').value = state.q;
}

function render() {
  const q = state.q.trim();
  const list = filtered();
  renderControls();
  renderToday();
  renderIntro();
  renderMineBar();
  $('#list').innerHTML = list.map((w) => cardHTML(w, q)).join('');
  $('#count').textContent = `${list.length}개 단어`;
  $('#empty').hidden = list.length > 0;
  $('#empty').textContent = state.kind === 'mine' && !state.q
    ? '아직 추가한 단어가 없습니다. Claude에게 사전에 없는 말을 물어보면 답 아래에 \'＋ 사전에 추가\' 버튼이 나타납니다.'
    : '찾는 단어가 없습니다. 다른 말로 검색하거나 필터를 풀어 보세요.';
}

// ── 내 단어: Claude에게 물어보고 추가한 항목(이 기기의 localStorage에만 저장) ──────
const CUSTOM_KEY = 'vocab.custom';
const POS_LIST = ['명사', '동사', '형용사', '부사', '관형사', '감탄사'];
function validCustom(w) {
  return w && typeof w.word === 'string' && /^[가-힣 ]{1,20}$/.test(w.word) && ['한자어', '고유어'].includes(w.kind)
    && Number.isInteger(w.topic) && w.topic >= 1 && w.topic <= 6 && POS_LIST.includes(w.pos)
    && w.fields && typeof w.fields['뜻'] === 'string' && typeof w.fields['예문'] === 'string';
}
function loadCustom() {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    return Array.isArray(list) ? list.filter(validCustom).map((w) => ({ ...w, custom: true })) : [];
  } catch { return []; }
}
function saveCustom() {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(DATA.words.filter((w) => w.custom))); return true; } catch { return false; }
}
/** 새 항목을 내 단어에 넣는다. { ok, id, reason } 를 돌려준다. */
function addCustom(entry) {
  const existing = DATA.words.find((w) => w.word === entry.word);
  if (existing) return { ok: false, reason: 'exists', id: existing.id };
  const w = { ...entry, custom: true, id: `u${Date.now().toString(36)}`, added: new Date().toISOString().slice(0, 10) };
  if (!validCustom(w)) return { ok: false, reason: 'invalid' };
  DATA.words.push(w);
  if (!saveCustom()) { DATA.words.pop(); return { ok: false, reason: 'storage' }; }
  buildLinkForms();
  render();
  return { ok: true, id: w.id };
}
function removeCustom(id) {
  DATA.words = DATA.words.filter((w) => w.id !== id);
  window.vocab = DATA;
  state.open.delete(id);
  saveCustom();
  buildLinkForms();
  render();
}
/** 사전 Markdown 형식으로 바꾼다. 들어갈 장 파일을 주석으로 함께 적는다. */
function customMarkdown() {
  const mine = DATA.words.filter((w) => w.custom);
  const groups = new Map();
  for (const w of mine) {
    const t = DATA.topics.find((x) => x.kind === w.kind && x.no === w.topic);
    const file = `${w.kind}/${String(t.no).padStart(2, '0')}-${t.name.replace(/·/g, '-')}.md`;
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(w);
  }
  return [...groups.entries()].map(([file, ws]) => `<!-- ${file} 에 넣을 항목 -->\n\n` + ws.map((w) => {
    const head = w.hanja ? (w.word.endsWith('하다') ? `${w.word.slice(0, -2)}(${w.hanja})하다` : `${w.word}(${w.hanja})`) : w.word;
    const lines = FIELD_ORDER.filter((f) => w.fields[f]).map((f) => `- **${f}**: ${w.fields[f]}`);
    return [`### ${head} 〔${w.pos}〕`, ...lines].join('\n');
  }).join('\n\n')).join('\n\n');
}
async function exportCustom() {
  const text = customMarkdown();
  const box = $('#mine-export-text');
  try {
    await navigator.clipboard.writeText(text);
    $('#mine-export').textContent = '복사했습니다 ✓';
    setTimeout(() => { $('#mine-export').textContent = '사전 형식(Markdown)으로 복사'; }, 2000);
  } catch {
    // 클립보드를 쓸 수 없으면 직접 복사할 수 있게 글 상자로 보여 준다.
    box.value = text; box.hidden = false; box.focus(); box.select();
  }
}

// ── 상태 ↔ URL 해시 ───────────────────────────────────
function writeHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.kind) p.set('k', state.kind);
  if (state.topic) p.set('t', state.topic);
  const h = p.toString();
  history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get('q') || '';
  state.kind = ['한자어', '고유어', 'mine'].includes(p.get('k')) ? p.get('k') : '';
  state.topic = Number(p.get('t')) || 0;
  return p.get('w');
}

// ── 동작 ──────────────────────────────────────────────
function toggle(id) {
  const card = document.getElementById(id);
  const w = DATA.words.find((x) => x.id === id);
  const open = !state.open.has(id);
  open ? state.open.add(id) : state.open.delete(id);
  card.toggleAttribute('data-open', open);
  card.querySelector('[data-toggle]').setAttribute('aria-expanded', String(open));
  const d = card.querySelector(`#${id}-d`);
  d.innerHTML = open ? detailHTML(w, state.q.trim()) : '';
  d.hidden = !open;
}

function goTo(id) {
  const w = DATA.words.find((x) => x.id === id);
  if (!w) return;
  if (!filtered().includes(w)) { state.q = ''; state.kind = ''; state.topic = 0; writeHash(); }
  state.open.add(id);
  render();
  const card = document.getElementById(id);
  card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  card.querySelector('[data-toggle]').focus({ preventScroll: true });
}

function bind() {
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; writeHash(); render(); });
  $('#kinds').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.kind = b.dataset.kind; writeHash(); render();
  });
  $('#topics').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    const t = Number(b.dataset.topic);
    state.topic = state.topic === t ? 0 : t; writeHash(); render();
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { e.preventDefault(); goTo(go.dataset.go); return; }
    const del = e.target.closest('[data-del-custom]');
    if (del) {
      const w = DATA.words.find((x) => x.id === del.dataset.delCustom);
      if (w && confirm(`'${w.word}'을(를) 내 단어에서 삭제할까요?`)) removeCustom(w.id);
      return;
    }
    const tg = e.target.closest('[data-toggle]');
    if (tg) toggle(tg.dataset.toggle);
  });
  $('#mine-export').addEventListener('click', exportCustom);
  window.addEventListener('hashchange', () => { const w = readHash(); render(); if (w) goTo(w); });
}

async function init() {
  const res = await fetch('words.json');
  DATA = await res.json();
  DATA.words.push(...loadCustom());
  buildLinkForms();
  const names = [...new Map(DATA.topics.map((t) => [t.no, t.name])).entries()];
  $('#topics').innerHTML = `<button class="chip" data-topic="0">전체 주제</button>` +
    names.map(([no, name]) => `<button class="chip" data-topic="${no}">${esc(name)}</button>`).join('');
  bind();
  window.vocab = DATA; // chat.js(Claude에게 묻기)가 사전 데이터를 쓴다
  window.vocabAddCustom = addCustom;
  window.vocabGoTo = goTo;
  window.dispatchEvent(new Event('vocab:ready'));
  const w = readHash();
  render();
  if (w) goTo(w);
}

init().catch((err) => {
  $('#list').innerHTML = `<p class="empty">사전 데이터를 불러오지 못했습니다. (${esc(String(err.message || err))})</p>`;
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
