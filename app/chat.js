// Claude에게 묻기: 사용자의 API 키로 브라우저에서 Claude API를 직접 호출한다.
// 키는 이 기기의 localStorage에만 저장되고 Claude API 요청 외에는 쓰지 않는다.
import Anthropic from './vendor/anthropic-sdk.js';

const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 — 깊이 있는 답 (기본)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 — 빠르고 저렴',
};
const DEFAULT_MODEL = 'claude-opus-5-5';
// 노력 수준: 생각의 깊이와 토큰 사용량을 정한다. 생각에 쓴 토큰도 출력 요금에 포함된다.
const EFFORTS = {
  low: { label: '낮음 — 빠르고 저렴 (기본)', short: '낮음' },
  medium: { label: '보통 — 균형', short: '보통' },
  high: { label: '높음 — 깊이 생각, 느리고 비쌈', short: '높음' },
};
const DEFAULT_EFFORT = 'low';
const LS = { key: 'vocab.apiKey', model: 'vocab.model', effort: 'vocab.effort' };
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

function renderHeader() {
  const w = currentWord();
  $('#chat-context').textContent = w ? wordLabel(w) : '사전 전체';
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
    $('#chat-model').value = store.get(LS.model) || DEFAULT_MODEL;
    $('#chat-effort').value = currentEffort();
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
  if (!dlg.open) dlg.showModal();
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
    if (/credit balance/i.test(err.message)) return 'API 크레딧이 부족합니다. Console에서 크레딧 잔액(또는 Max 플랜 월간 크레딧 연결)을 확인해 주세요.';
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

  const ctx = contextFor(question);
  chat.history.push({ role: 'user', content: ctx.text + question });
  const rollback = () => { chat.history.pop(); ctx.ids.forEach((id) => chat.given.delete(id)); };
  addBubble('user', `<p>${esc(question).replace(/\n/g, '<br>')}</p>`);
  input.value = ''; autosize();
  const bubble = addBubble('assistant', '<p class="thinking">생각하는 중…</p>');
  setBusy(true);

  const model = store.get(LS.model) || DEFAULT_MODEL;
  const effort = currentEffort();
  const params = {
    model,
    max_tokens: 8000,
    system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
    messages: chat.history,
    output_config: { effort },
  };
  if (model === 'claude-opus-5-5') {
    // 안전 분류기가 거절하면 서버가 권장 모델로 다시 시도한다.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let text = '';
  try {
    const stream = client().beta.messages.stream(params);
    chat.stream = stream;
    stream.on('streamEvent', (ev) => {
      // 모델이 바뀌는 지점(fallback 블록) 이전의 부분 답은 버린다.
      if (ev.type === 'content_block_start' && ev.content_block.type === 'fallback') text = '';
    });
    stream.on('text', (delta) => {
      text += delta;
      bubble.innerHTML = renderMarkdown(text);
      log.scrollTop = log.scrollHeight;
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === 'refusal') {
      rollback();
      bubble.classList.add('error');
      bubble.innerHTML = '<p>이 질문에는 답할 수 없다는 응답을 받았습니다. 질문을 바꿔 다시 물어봐 주세요.</p>';
      return;
    }
    chat.history.push({ role: 'assistant', content: msg.content });
    bubble.innerHTML = renderMarkdown(text || '(빈 응답)');
    if (msg.stop_reason === 'max_tokens') bubble.insertAdjacentHTML('beforeend', '<p class="meta">답이 길어 중간에 끊겼습니다. "계속"이라고 보내면 이어서 씁니다.</p>');
    const u = msg.usage;
    const inTok = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    bubble.insertAdjacentHTML('beforeend', `<p class="meta">${esc(msg.model)} · 노력 ${EFFORTS[effort].short} · 입력 ${inTok.toLocaleString()} · 출력 ${u.output_tokens.toLocaleString()} 토큰</p>`);
  } catch (err) {
    rollback(); // 실패한 질문은 대화 기록에서 뺀다
    const partial = text ? renderMarkdown(text) : '';
    bubble.classList.add('error');
    bubble.innerHTML = partial + `<p class="meta">${esc(errorMessage(err))}</p>`;
    if (err instanceof Anthropic.AuthenticationError) showSetup(true, errorMessage(err));
  } finally {
    chat.stream = null;
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
$('#chat-settings').addEventListener('click', () => showSetup(setup.hidden));
dlg.addEventListener('close', () => { if (chat.stream) chat.stream.abort(); });

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
  showSetup(false);
  input.focus();
});
$('#chat-forget').addEventListener('click', () => {
  store.del(LS.key);
  $('#chat-key').value = '';
  $('#chat-forget').hidden = true;
});

window.addEventListener('vocab:ready', () => { $('#chat-fab').hidden = false; });
if (window.vocab) $('#chat-fab').hidden = false;
