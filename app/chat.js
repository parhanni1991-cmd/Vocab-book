// Claude에게 묻기: 사용자의 API 키로 브라우저에서 Claude API를 직접 호출한다.
// 키는 이 기기의 localStorage에만 저장되고 Claude API 요청 외에는 쓰지 않는다.
import Anthropic from './vendor/anthropic-sdk.js';

const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 — 깊이 있는 답 (기본)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 — 빠르고 균형 잡힌 답',
};
const MODEL_SHORT = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5' };
const DEFAULT_MODEL = 'claude-opus-5-5';
// 노력 수준: 생각의 깊이와 토큰 사용량을 정한다. 생각에 쓴 토큰도 출력 요금에 포함된다.
const EFFORTS = {
  low: { label: '낮음 — 빠르고 저렴 (기본)', short: '낮음' },
  medium: { label: '보통 — 균형', short: '보통' },
  high: { label: '높음 — 깊이 생각, 느리고 비쌈', short: '높음' },
};
const DEFAULT_EFFORT = 'low';
const LS = { key: 'vocab.apiKey', model: 'vocab.model', effort: 'vocab.effort', limit: 'vocab.limit', spend: 'vocab.spend' };
const currentModel = () => {
  let m = store.get(LS.model);
  // 예전에 고를 수 있던 Haiku를 골라 둔 경우 그 자리를 대신하는 Sonnet으로 옮긴다.
  if (m === 'claude-haiku-5-5') { m = 'claude-sonnet-5-5'; store.set(LS.model, m); }
  return Object.hasOwn(MODELS, m ?? '') ? m : DEFAULT_MODEL;
};
const currentEffort = () => { const e = store.get(LS.effort); return Object.hasOwn(EFFORTS, e ?? "") ? e : DEFAULT_EFFORT; };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ── 저장소 (사생활 보호 모드 등에서 실패해도 메모리로 동작) ──────────
const memStore = {};
const store = {
  get(k) { try { return localStorage.getItem(k) ?? memStore[k] ?? null; } catch { return memStore[k] ?? null; } },
  set(k, v) { memStore[k] = v; try { localStorage.setItem(k, v); } catch { /* 메모리에만 보관 */ } },
  del(k) { delete memStore[k]; try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

// ── 월 사용 한도 ─────────────────────────────────────────
// 1M 토큰당 달러(입력·출력·캐시 읽기·캐시 쓰기). 표에 없는 모델(거절 시 대체 모델 등)은 높게 잡는다.
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const UNKNOWN_PRICE = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const DEFAULT_LIMIT = 100;   // Max 5x 월간 API 크레딧
const MAX_OUTPUT = 8000;     // 평소 답의 최대 길이(토큰)
const MIN_OUTPUT = 1000;     // 한도가 이보다 적게 남으면 새 질문을 받지 않는다

const priceOf = (model) => PRICES[model] || UNKNOWN_PRICE;
const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
function spentThisMonth() {
  try { const r = JSON.parse(store.get(LS.spend) || 'null'); return r && r.month === monthKey() ? r.usd : 0; } catch { return 0; }
}
function addSpend(usd) { store.set(LS.spend, JSON.stringify({ month: monthKey(), usd: spentThisMonth() + usd })); }
/** 빈칸이나 0은 한도 없음(Infinity). 한 번도 정하지 않았으면 기본값. */
function monthlyLimit() {
  const v = store.get(LS.limit);
  if (v === null) return DEFAULT_LIMIT;
  const n = Number(v);
  return n > 0 ? n : Infinity;
}
function costOf(model, u) {
  const p = priceOf(model);
  return (u.input_tokens * p.in + u.output_tokens * p.out
    + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}
const usd = (n) => '$' + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));
function usageText() {
  const lim = monthlyLimit();
  return `이번 달 ${usd(spentThisMonth())}` + (Number.isFinite(lim) ? ` / ${usd(lim)}` : ' (한도 없음)');
}

// ── 대화 상태 ────────────────────────────────────────────
const chat = {
  wordId: null,   // 대화가 다루는 단어
  history: [],    // API에 보내는 messages (append-only)
  given: new Set(), // 이미 대화에 넣은 사전 항목 id
  stream: null,
};

// ── 사전 데이터 → 프롬프트 ────────────────────────────────
function vocab() { return window.vocab; }

function entryText(w) {
  const t = vocab().topics.find((t) => t.kind === w.kind && t.no === w.topic);
  const head = `■ ${w.word}${w.hanja ? `(${w.hanja})` : ''} 〔${w.pos}〕 · ${w.kind} · ${t.no}. ${t.name}`;
  const lines = Object.entries(w.fields).map(([k, v]) => `- ${k}: ${v}`);
  return [head, ...lines].join('\n');
}

let SYSTEM = null;
function systemPrompt() {
  if (SYSTEM) return SYSTEM;
  const { words, topics } = vocab();
  const index = topics.map((t) => {
    const ws = words.filter((w) => w.kind === t.kind && w.topic === t.no).map((w) => w.word);
    return `${t.kind} ${t.no}. ${t.name}: ${ws.join(', ')}`;
  }).join('\n');
  SYSTEM = `너는 소설을 쓰는 사람을 돕는 한국어 어휘 코치다. 사용자는 한자어·고유어 어휘 사전으로 어휘력을 기르고 있다.

답하는 방식:
- 한국어로 답한다. 소설 문장을 쓰는 데 바로 쓸 수 있게 실용적으로 답한다.
- 질문과 함께 [사전 항목]이 주어지면 그 뜻풀이를 기준으로 삼는다. 사전 항목에 없는 내용(다른 뜻, 어원, 용법 등)을 말할 때는 사전 밖의 설명임을 밝히고, 확실하지 않은 것은 확실하지 않다고 말한다.
- 예문은 장면과 감각이 살아 있는 소설 문장으로 쓴다.
- 휴대폰 화면에서 읽는다. 짧은 문단과 짧은 목록으로 쓰고, 굵은 글씨는 꼭 필요한 곳에만 쓴다. 표는 쓰지 않는다.
- 퀴즈를 낼 때는 정답을 함께 알려 주지 말고 사용자의 답을 기다린다.
- 사전에 있는 단어를 추천할 때는 아래 표제어 목록에서 고른다.

사전 도구:
- 이 사전의 207개 항목 전체를 도구로 찾아볼 수 있다. search_dictionary(뜻·예문·유의어까지 검색), list_topic(주제별 목록), get_entries(항목 전체).
- [사전 항목]으로 받지 않은 표제어의 뜻을 설명하거나, 그 말로 예문을 쓰거나, 여러 말을 비교할 때는 먼저 get_entries로 항목을 확인하고 그 뜻풀이에 맞춘다.
- 장면이나 느낌에 맞는 말을 찾을 때는 search_dictionary나 list_topic으로 후보를 찾은 뒤 고른다.
- 필요한 항목은 한 번에 모아서 조회한다(get_entries는 최대 10개).

사전 표제어 목록:
${index}`;
  return SYSTEM;
}

/** 이번 질문에 붙일 사전 항목: 대화 단어(처음 한 번) + 질문에 나온 표제어 중 아직 안 넣은 것 */
function contextFor(question) {
  const { words } = vocab();
  const picks = [];
  const add = (w) => { if (w && !chat.given.has(w.id)) { chat.given.add(w.id); picks.push(w); } };
  if (chat.wordId) add(words.find((w) => w.id === chat.wordId));
  for (const w of words) {
    const stem = w.word.replace(/하다$/, '');
    if (question.includes(w.word) || (stem.length >= 2 && question.includes(stem))) add(w);
    if (picks.length >= 6) break;
  }
  const text = picks.length ? `[사전 항목]\n${picks.map(entryText).join('\n\n')}\n\n` : '';
  return { text, ids: picks.map((w) => w.id) };
}

// ── Claude가 쓰는 사전 도구 ────────────────────────────────
const TOPIC_NAMES = '1 감정·심리, 2 인물·외모·성격, 3 동작·행위, 4 자연·풍경·날씨, 5 시간·계절, 6 공간·분위기·감각';
const TOOLS = [
  {
    name: 'search_dictionary',
    description: '이 사전(한자어 103개, 고유어 104개)에서 낱말을 찾는다. 표제어·한자·뜻풀이·유의어·대응어·예문·참고를 검색하므로 장면이나 느낌을 나타내는 말(예: "비", "쓸쓸", "새벽")로도 찾을 수 있다. 결과는 표제어와 첫 뜻풀이 목록(최대 15개)이다. 항목 전체는 get_entries로 본다.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '찾을 말. 한 낱말이나 짧은 구절.' } },
      required: ['query'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: 'list_topic',
    description: `한 주제에 속한 표제어 전체를 첫 뜻풀이와 함께 보여 준다. 주제 번호: ${TOPIC_NAMES}.`,
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['한자어', '고유어'] },
        topic: { type: 'integer', minimum: 1, maximum: 6, description: TOPIC_NAMES },
      },
      required: ['kind', 'topic'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: 'get_entries',
    description: '표제어의 사전 항목 전체(품사, 한자와 훈음, 뜻풀이, 예문, 유의어, 대응어, 참고)를 가져온다. 한 번에 최대 10개.',
    input_schema: {
      type: 'object',
      properties: {
        words: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: '표제어 목록. 예: ["적막", "괴괴하다"]' },
      },
      required: ['words'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];
const MAX_STEPS = 6; // 한 질문에서 도구를 쓰며 주고받는 최대 횟수(마지막 회차는 도구 없이 답하게 한다)

class ToolInputError extends Error {}
const gistOf = (w) => w.fields['뜻'].split(/\s(?=[②③④⑤⑥⑦⑧⑨⑩])/)[0].replace(/^①\s*/, '');
function brief(w) {
  const t = vocab().topics.find((t) => t.kind === w.kind && t.no === w.topic);
  return `${w.word}${w.hanja ? `(${w.hanja})` : ''} · ${w.kind} ${t.no}. ${t.name} — ${gistOf(w)}`;
}
function findWord(name) {
  const { words } = vocab();
  const n = name.trim();
  const stem = n.replace(/하다$/, '');
  return words.find((w) => w.word === n) || words.find((w) => w.word === `${n}하다`)
    || words.find((w) => stem.length >= 2 && w.word.replace(/하다$/, '') === stem);
}

/** 도구를 실행하고 { text: Claude에게 줄 결과, label: 화면에 보일 한 줄 }을 돌려준다. 입력이 틀리면 ToolInputError. */
function runTool(name, input) {
  const { words, topics } = vocab();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolInputError('입력은 객체여야 한다.');
  if (name === 'search_dictionary') {
    const q = input.query;
    if (typeof q !== 'string' || !q.trim() || q.length > 50) throw new ToolInputError('query는 1~50자 문자열이어야 한다.');
    const query = q.trim();
    const scored = words.map((w) => {
      let score = 0;
      if (w.word.includes(query) || query.includes(w.word.replace(/하다$/, ''))) score += 5;
      if (w.hanja && w.hanja.includes(query)) score += 4;
      for (const [f, v] of Object.entries(w.fields)) {
        if (!v.includes(query)) continue;
        score += f === '뜻' ? 3 : f === '유의어' || f.endsWith('대응') ? 2 : 1;
      }
      return { w, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);
    return {
      label: `사전 검색 “${query}” · ${scored.length}개`,
      text: scored.length ? scored.map((x) => brief(x.w)).join('\n') : `“${query}”와 맞는 항목이 없다. 다른 말로 찾거나 list_topic을 써 본다.`,
    };
  }
  if (name === 'list_topic') {
    const { kind, topic } = input;
    if (kind !== '한자어' && kind !== '고유어') throw new ToolInputError('kind는 "한자어" 또는 "고유어"여야 한다.');
    if (!Number.isInteger(topic) || topic < 1 || topic > 6) throw new ToolInputError('topic은 1~6의 정수여야 한다.');
    const t = topics.find((x) => x.kind === kind && x.no === topic);
    const list = words.filter((w) => w.kind === kind && w.topic === topic);
    return { label: `주제 목록 · ${kind} ${topic}. ${t.name}`, text: `[${kind} ${topic}. ${t.name}] ${t.intro}\n${list.map(brief).join('\n')}` };
  }
  if (name === 'get_entries') {
    const ws = input.words;
    if (!Array.isArray(ws) || !ws.length || ws.length > 10 || !ws.every((x) => typeof x === 'string' && x.trim())) {
      throw new ToolInputError('words는 표제어 문자열 1~10개의 배열이어야 한다.');
    }
    const found = ws.map((x) => [x, findWord(x)]);
    return {
      label: `항목 조회 · ${ws.join(', ')}`,
      text: found.map(([x, w]) => (w ? entryText(w) : `■ ${x}: 이 사전에 없는 표제어다.`)).join('\n\n'),
    };
  }
  throw new ToolInputError(`알 수 없는 도구: ${name}`);
}

// ── 간단한 마크다운 → HTML (이스케이프 후 굵게·목록·줄바꿈만) ──────────
function renderMarkdown(src) {
  const lines = esc(src).split('\n');
  let html = '', list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
    close();
    if (!line.trim()) { html += '<div class="gap"></div>'; continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { html += `<p><strong>${inline(m[1])}</strong></p>`; continue; }
    html += `<p>${inline(line)}</p>`;
  }
  close();
  return html;
}

// ── 화면 ────────────────────────────────────────────────
const dlg = $('#chat');
const log = $('#chat-log');
const input = $('#chat-text');
const sendBtn = $('#chat-send');
const quick = $('#chat-quick');
const setup = $('#chat-setup');

function wordLabel(w) { return `${w.word}${w.hanja ? `(${w.hanja})` : ''}`; }
function currentWord() { return chat.wordId ? vocab().words.find((w) => w.id === chat.wordId) : null; }

// ── 상단 모델·노력 배지와 빠른 선택 메뉴 ───────────────────
const modeBtn = $('#chat-mode-btn');
const modeMenu = $('#chat-mode-menu');
// 선택 버튼은 한 번만 만들고, 고를 때는 선택 표시만 바꾼다(다시 그리면 누른 버튼이 사라져 바깥 클릭으로 오인된다).
const seg = (items, kind) => items.map(([id, label]) =>
  `<button type="button" role="radio" data-${kind}="${id}">${esc(label)}</button>`).join('');
$('#mode-models').innerHTML = seg(Object.entries(MODEL_SHORT), 'model');
$('#mode-efforts').innerHTML = seg(Object.entries(EFFORTS).map(([id, e]) => [id, e.short]), 'effort');
function renderModeBadge() {
  const model = currentModel(), effort = currentEffort();
  modeBtn.textContent = `${MODEL_SHORT[model]} · 노력 ${EFFORTS[effort].short} ▾`;
  modeMenu.querySelectorAll('[data-model], [data-effort]').forEach((b) => {
    const on = b.dataset.model ? b.dataset.model === model : b.dataset.effort === effort;
    b.setAttribute('aria-checked', String(on));
    b.setAttribute('aria-selected', String(on));
  });
}
function toggleModeMenu(show = modeMenu.hidden) {
  modeMenu.hidden = !show;
  modeBtn.setAttribute('aria-expanded', String(show));
}
modeBtn.addEventListener('click', () => toggleModeMenu());
modeMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-model], [data-effort]');
  if (!b) return;
  if (b.dataset.model) store.set(LS.model, b.dataset.model);
  if (b.dataset.effort) store.set(LS.effort, b.dataset.effort);
  renderModeBadge();
});
// 메뉴 바깥을 누르면 닫는다.
document.addEventListener('click', (e) => {
  if (!modeMenu.hidden && !e.target.closest('.chat-bar')) toggleModeMenu(false);
});

function renderHeader() {
  renderModeBadge();
  const w = currentWord();
  $('#chat-context').textContent = `${w ? wordLabel(w) : '사전 전체'} · ${usageText()}`;
}

function renderQuick() {
  const w = currentWord();
  const items = w ? [
    ['뉘앙스 비교', `「${w.word}」와 유의어·대응어의 뉘앙스 차이를 짧은 장면 예시와 함께 설명해 줘.`],
    ['예문 더 보기', `「${w.word}」를 써서 서로 다른 장면의 소설 예문 3개를 보여 줘.`],
    ['내 문장 다듬기', `「${w.word}」를 살려서 다음 문장을 다듬어 줘:\n`, true],
    ['퀴즈', `「${w.word}」와 같은 주제의 단어로 뜻 맞히기 퀴즈를 하나 내 줘.`],
  ] : [
    ['장면별 추천', '비 오는 밤 장면에 어울리는 단어를 이 사전에서 골라 예문과 함께 추천해 줘.'],
    ['퀴즈', '이 사전의 단어로 뜻 맞히기 퀴즈를 하나 내 줘.'],
    ['한자어 ↔ 고유어', '같은 장면을 한자어 위주 문장과 고유어 위주 문장으로 각각 써서 느낌 차이를 보여 줘.'],
  ];
  quick.innerHTML = items.map(([label, text, fill], i) =>
    `<button type="button" class="chip" data-i="${i}">${esc(label)}</button>`).join('');
  quick.onclick = (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    const [, text, fill] = items[Number(b.dataset.i)];
    if (fill) { input.value = text; autosize(); input.focus(); input.setSelectionRange(text.length, text.length); }
    else ask(text);
  };
  quick.hidden = !setup.hidden || chat.history.length > 0;
}

function addBubble(role, html, cls = '') {
  const div = document.createElement('div');
  div.className = `bubble ${role} ${cls}`.trim();
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function showSetup(show, message = '') {
  const msg = $('#chat-setup-msg');
  msg.textContent = message;
  msg.hidden = !message;
  setup.hidden = !show;
  $('#chat-form').hidden = show;
  log.hidden = show;
  quick.hidden = show || chat.history.length > 0;
  if (show) {
    $('#chat-key').value = store.get(LS.key) || '';
    $('#chat-model').value = currentModel();
    $('#chat-effort').value = currentEffort();
    const lim = monthlyLimit();
    $('#chat-limit').value = Number.isFinite(lim) ? lim : '';
    $('#chat-usage').textContent = `${usageText()} (추정)`;
    $('#chat-forget').hidden = !store.get(LS.key);
    $('#chat-key').focus();
  }
}

function resetConversation() {
  if (chat.stream) chat.stream.abort();
  chat.history = []; chat.given = new Set();
  log.innerHTML = '';
  const w = currentWord();
  addBubble('note', w
    ? `<p><strong>${esc(wordLabel(w))}</strong>에 대해 무엇이든 물어보세요. 사전 항목을 함께 보내서 답의 기준으로 삼게 합니다.</p>`
    : '<p>사전에 있는 단어나 글쓰기 표현에 대해 물어보세요.</p>');
  renderHeader(); renderQuick();
}

function open(wordId) {
  if (!vocab()) return;
  if (wordId !== undefined && wordId !== chat.wordId) { chat.wordId = wordId; resetConversation(); }
  else if (!log.childElementCount) resetConversation();
  if (!dlg.open) {
    if (isPhone()) enterChatMode();
    dlg.showModal();
    fitToViewport();
  }
  if (!store.get(LS.key)) showSetup(true);
  else { showSetup(false); input.focus(); }
}

// ── API 호출 ─────────────────────────────────────────────
function client() {
  return new Anthropic({ apiKey: store.get(LS.key), dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function errorMessage(err) {
  if (err instanceof Anthropic.APIUserAbortError) return '답변을 중지했습니다.';
  if (err instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다. Console에서 키를 확인해 다시 입력해 주세요.';
  if (err instanceof Anthropic.PermissionDeniedError) return '이 API 키로는 요청할 권한이 없습니다. Console에서 키의 권한을 확인해 주세요.';
  if (err instanceof Anthropic.RateLimitError) return '요청이 많아 잠시 제한되었습니다. 조금 뒤에 다시 시도해 주세요.';
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return 'API 크레딧을 다 써서 더 이상 답할 수 없습니다. 크레딧이 다시 채워지면(다음 결제 주기) 다시 쓸 수 있습니다. 잔액은 Console의 Billing에서 확인하세요.';
    return `요청을 처리하지 못했습니다: ${err.message}`;
  }
  if (err instanceof Anthropic.InternalServerError) return 'Claude 서버가 일시적으로 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.';
  if (err instanceof Anthropic.APIConnectionError) return '인터넷 연결을 확인해 주세요. AI 질문은 온라인에서만 됩니다.';
  return `오류가 발생했습니다: ${err.message || err}`;
}

function setBusy(busy) {
  sendBtn.textContent = busy ? '중지' : '보내기';
  sendBtn.classList.toggle('stop', busy);
  input.disabled = busy;
  quick.hidden = busy || chat.history.length > 0;
}

async function ask(question) {
  question = question.trim();
  if (!question || chat.stream) return;
  if (!store.get(LS.key)) { showSetup(true); return; }

  const base = chat.history.length;
  const ctx = contextFor(question);
  chat.history.push({ role: 'user', content: ctx.text + question });
  // 실패·거절·한도 초과로 끝난 질문은 대화 기록에서 통째로 뺀다(뒤에서 자르기만 하므로 기록은 append-only로 유지).
  const rollback = () => { chat.history.length = base; ctx.ids.forEach((id) => chat.given.delete(id)); };
  addBubble('user', `<p>${esc(question).replace(/\n/g, '<br>')}</p>`);
  input.value = ''; autosize();
  const bubble = addBubble('assistant', '<p class="thinking">생각하는 중…</p>');
  setBusy(true);

  const model = currentModel();
  const effort = currentEffort();
  const lim = monthlyLimit();

  // 화면: 답 글과 도구 사용 줄을 차례로 보여 준다.
  const segments = [];
  const render = (thinking = false) => {
    bubble.innerHTML = segments.map((sg) => (sg.tool ? `<p class="tool">📖 ${esc(sg.tool)}</p>` : renderMarkdown(sg.text))).join('')
      + (thinking || !segments.length ? '<p class="thinking">생각하는 중…</p>' : '');
    log.scrollTop = log.scrollHeight;
  };
  const fail = (html) => { bubble.classList.add('error'); segments.length = 0; bubble.innerHTML = html; };

  let totalCost = 0, inTok = 0, outTok = 0, toolCalls = 0, lastModel = model;
  let stream = null, charged = true, cappedStep = false, ended = false, lastStop = null;
  const charge = (m) => {
    if (charged || !m?.usage) return;
    charged = true;
    const c = costOf(m.model, m.usage);
    addSpend(c); totalCost += c;
    inTok += m.usage.input_tokens + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
    outTok += m.usage.output_tokens;
  };

  try {
    for (let step = 0; step < MAX_STEPS && !ended; step += 1) {
      // 남은 한도로 쓸 수 있는 만큼만 답하게 max_tokens를 줄인다. 한도에 이르면 답이 그 자리에서 끊긴다.
      let maxTokens = MAX_OUTPUT;
      if (Number.isFinite(lim)) {
        const price = priceOf(model);
        // 입력 토큰은 글자 수로 넉넉하게 어림한다(한국어는 대개 글자당 1토큰 이하).
        const inputEstimate = systemPrompt().length + JSON.stringify(chat.history).length;
        const left = lim - spentThisMonth() - inputEstimate * price.in / 1e6;
        maxTokens = Math.min(MAX_OUTPUT, Math.floor(left / (price.out / 1e6)));
        if (maxTokens < MIN_OUTPUT) {
          rollback();
          fail(`<p>이번 달 사용 한도(${usd(lim)})에 도달해 ${step ? '답을 마치지 못했습니다' : '더 이상 질문을 보내지 않습니다'}.</p>`
            + `<p class="meta">${esc(usageText())} (추정) · 설정에서 한도를 올리거나 다음 달에 다시 이용해 주세요.</p>`);
          return;
        }
      }
      cappedStep = maxTokens < MAX_OUTPUT;

      const params = {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
        messages: chat.history,
        tools: TOOLS,
        output_config: { effort },
      };
      // 마지막 회차에는 도구를 더 쓰지 말고 지금까지 찾은 것으로 답하게 한다.
      if (step === MAX_STEPS - 1) params.tool_choice = { type: 'none' };
      // 안전 분류기가 거절하면 서버가 권장 모델로 다시 시도한다(Opus 5.5·Sonnet 5.5 모두 'default' 형식 지원).
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';

      const seg = { text: '' };
      segments.push(seg);
      charged = false;
      stream = client().beta.messages.stream(params);
      chat.stream = stream;
      stream.on('streamEvent', (ev) => {
        // 모델이 바뀌는 지점(fallback 블록) 이전의 부분 답은 버린다.
        if (ev.type === 'content_block_start' && ev.content_block.type === 'fallback') { seg.text = ''; render(true); }
      });
      stream.on('text', (delta) => { seg.text += delta; render(true); });
      const msg = await stream.finalMessage();
      charge(msg);
      lastModel = msg.model;
      lastStop = msg.stop_reason;
      if (!seg.text) segments.splice(segments.indexOf(seg), 1);

      if (msg.stop_reason === 'refusal') {
        rollback();
        fail('<p>이 질문에는 답할 수 없다는 응답을 받았습니다. 질문을 바꿔 다시 물어봐 주세요.</p>');
        return;
      }
      const toolUses = msg.content.filter((b) => b.type === 'tool_use');
      if (msg.stop_reason === 'max_tokens') {
        if (toolUses.length) {
          // 도구 호출이 잘린 채 끝났다: 실행하지 않고 이 질문을 기록에서 뺀다.
          rollback();
          render();
          bubble.insertAdjacentHTML('beforeend', `<p class="meta warn">${cappedStep ? '이번 달 사용 한도에 거의 도달해' : '답이 길어'} 중간에 끊겼습니다. 이 질문은 대화 기록에서 뺐습니다.</p>`);
          return;
        }
        chat.history.push({ role: 'assistant', content: msg.content });
        ended = true;
        break;
      }
      chat.history.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason !== 'tool_use' || !toolUses.length) { ended = true; break; }

      // 도구 실행: 입력을 직접 검증하고, 틀리면 실행하지 않고 오류 결과를 돌려준다.
      const results = toolUses.map((b) => {
        try {
          const r = runTool(b.name, b.input);
          toolCalls += 1;
          segments.push({ tool: r.label });
          return { type: 'tool_result', tool_use_id: b.id, content: r.text };
        } catch (e) {
          if (!(e instanceof ToolInputError)) throw e;
          return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: b.input ?? null, error: e.message }) };
        }
      });
      chat.history.push({ role: 'user', content: results });
      render(true);
    }

    render();
    if (!segments.some((sg) => sg.text)) bubble.insertAdjacentHTML('beforeend', '<p>(빈 응답)</p>');
    if (lastStop === 'max_tokens') {
      bubble.insertAdjacentHTML('beforeend', cappedStep
        ? '<p class="meta warn">이번 달 사용 한도에 거의 도달해 답이 중간에 끊겼습니다.</p>'
        : '<p class="meta">답이 길어 중간에 끊겼습니다. "계속"이라고 보내면 이어서 씁니다.</p>');
    }
    bubble.insertAdjacentHTML('beforeend', `<p class="meta">${esc(lastModel)} · 노력 ${EFFORTS[effort].short}${toolCalls ? ` · 사전 조회 ${toolCalls}회` : ''} · 입력 ${inTok.toLocaleString()} · 출력 ${outTok.toLocaleString()} 토큰 · 약 ${usd(totalCost)}</p>`);
  } catch (err) {
    // 중지·끊김으로 받다 만 답도 요금이 나오므로, 받은 만큼(보이지 않는 생각 토큰은 어림) 사용액에 더한다.
    const partialMsg = stream?.currentMessage;
    const partialText = segments.map((sg) => sg.text || '').join('');
    if (partialMsg) charge({ model: partialMsg.model, usage: { ...partialMsg.usage, output_tokens: Math.max(partialMsg.usage.output_tokens, partialText.length) } });
    rollback();
    bubble.classList.add('error');
    render();
    bubble.insertAdjacentHTML('beforeend', `<p class="meta">${esc(errorMessage(err))}</p>`);
    if (err instanceof Anthropic.AuthenticationError) showSetup(true, errorMessage(err));
  } finally {
    chat.stream = null;
    renderHeader();
    setBusy(false);
    if (setup.hidden) input.focus();
  }
}

// ── 이벤트 연결 ──────────────────────────────────────────
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }

$('#chat-model').innerHTML = Object.entries(MODELS).map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
$('#chat-effort').innerHTML = Object.entries(EFFORTS).map(([id, e]) => `<option value="${id}">${esc(e.label)}</option>`).join('');

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ask]');
  if (b) { e.preventDefault(); open(b.dataset.ask || null); }
});
$('#chat-fab').addEventListener('click', () => open());
$('#chat-close').addEventListener('click', () => dlg.close());
$('#chat-new').addEventListener('click', () => resetConversation());
$('#chat-settings').addEventListener('click', () => { toggleModeMenu(false); showSetup(setup.hidden); });
// Esc: 메뉴가 열려 있으면 대화창은 두고 메뉴만 닫는다(대화창이 닫히기 전에 키를 먼저 가로챈다).
dlg.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modeMenu.hidden) { e.preventDefault(); e.stopPropagation(); toggleModeMenu(false); modeBtn.focus(); }
}, true);
dlg.addEventListener('cancel', (e) => { if (!modeMenu.hidden) { e.preventDefault(); toggleModeMenu(false); } });
dlg.addEventListener('close', () => {
  if (chat.stream) chat.stream.abort();
  exitChatMode();
});

// ── 휴대폰: 대화 화면 모드 ─────────────────────────────────
// 휴대폰에서는 대화창을 사전 화면 위에 띄우지 않고 사전 화면을 숨긴 채 전체 화면으로 쓴다.
// iOS는 키보드가 올라오면 문서를 밀어 올려, 겹쳐 띄운 창 뒤로 사전 화면이 비치고 창이 흔들렸다.
// 그래서 (1) 사전 화면을 그리지 않고 (2) body를 고정해 문서가 움직이지 않게 하고
// (3) 대화창 높이만 보이는 영역(visualViewport)에 맞춘다. 위치는 쫓아가지 않고 밀려 올라가면 되돌린다.
const vv = window.visualViewport;
const root = document.documentElement;
const isPhone = () => matchMedia('(max-width: 699px)').matches;
let savedScrollY = 0;

function enterChatMode() {
  savedScrollY = window.scrollY;
  root.classList.add('chat-mode');
  Object.assign(document.body.style, { position: 'fixed', top: `-${savedScrollY}px`, left: '0', right: '0' });
  document.addEventListener('touchmove', blockStrayTouch, { passive: false });
}
function exitChatMode() {
  if (!root.classList.contains('chat-mode')) return;
  root.classList.remove('chat-mode');
  Object.assign(document.body.style, { position: '', top: '', left: '', right: '' });
  document.removeEventListener('touchmove', blockStrayTouch);
  window.scrollTo(0, savedScrollY);
}

/** 스크롤할 내용이 있는 곳(대화 기록·설정·입력창) 밖에서 끄는 손가락은 화면 전체를 끌지 못하게 막는다. */
function blockStrayTouch(e) {
  const area = e.target.closest?.('#chat-log, #chat-setup, #chat-text');
  if (area && area.scrollHeight > area.clientHeight) return;
  e.preventDefault();
}

let fitQueued = false;
function fitToViewport() {
  if (!vv || !dlg.open || fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    dlg.style.setProperty('--vv-height', `${vv.height}px`);
    dlg.classList.toggle('kb', root.clientHeight - vv.height > 120);
    // iOS가 입력창을 보이려고 화면을 밀어 올렸으면 되돌린다(대화창은 이미 보이는 높이에 맞춰져 있다).
    if (root.classList.contains('chat-mode') && vv.offsetTop > 0) window.scrollTo(0, 0);
    if (document.activeElement === input) log.scrollTop = log.scrollHeight;
  });
}
if (vv) {
  vv.addEventListener('resize', fitToViewport);
  vv.addEventListener('scroll', fitToViewport);
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (chat.stream) { chat.stream.abort(); return; }
  ask(input.value);
});
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  // 한글 조합 중(isComposing)의 Enter는 글자 확정이므로 보내지 않는다.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

$('#chat-setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('#chat-key').value.trim();
  if (!key) { $('#chat-key').focus(); return; }
  store.set(LS.key, key);
  store.set(LS.model, $('#chat-model').value);
  store.set(LS.effort, $('#chat-effort').value);
  const limitValue = $('#chat-limit').value.trim();
  store.set(LS.limit, limitValue === '' ? '0' : String(Math.max(0, Number(limitValue) || 0)));
  renderHeader();
  showSetup(false);
  input.focus();
});
$('#chat-reset-usage').addEventListener('click', () => {
  if (!confirm('이번 달 사용액 기록을 0으로 되돌릴까요? (실제 크레딧 잔액은 바뀌지 않습니다)')) return;
  store.del(LS.spend);
  $('#chat-usage').textContent = `${usageText()} (추정)`;
  renderHeader();
});
$('#chat-forget').addEventListener('click', () => {
  store.del(LS.key);
  $('#chat-key').value = '';
  $('#chat-forget').hidden = true;
});

window.addEventListener('vocab:ready', () => { $('#chat-fab').hidden = false; });
if (window.vocab) $('#chat-fab').hidden = false;
