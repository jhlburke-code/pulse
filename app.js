// Pulse — shared client logic
// Reads ?session=<uuid> from the URL when present to switch between create / live / join / vote / thanks views.
// Holds Supabase URL + anon key in one place. RLS on the backend handles auth (anonymous read+insert).

const SUPABASE_URL = 'https://axwipqlykysnxudnejvi.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4d2lwcWx5a3lzbnh1ZG5lanZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODg2NTcsImV4cCI6MjEwMDA2NDY1N30.uTgP-OfI5NtknLCw_LjvXY3tTKNfKc83DJcFRrvwgb8';

let sb = null;
let realtimeChannel = null;
let currentSession = null;
let responseCache = [];

// ---------- Supabase bootstrap ----------

function initSupabase() {
  if (!window.supabase) {
    console.warn('Supabase JS not loaded');
    return null;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

// ---------- Helpers ----------

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skip I/O/0/1 for readability
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function getSessionIdFromUrl() {
  const u = new URL(location.href);
  return u.searchParams.get('session');
}

function buildUrl(view) {
  const u = new URL(location.href);
  u.search = '';
  if (currentSession) u.searchParams.set('session', currentSession.id);
  if (view === 'thanks') u.searchParams.set('done', '1');
  return u.toString();
}

function navigate(view) {
  history.pushState({}, '', buildUrl(view));
  render();
}

// ---------- Supabase ops ----------

async function createSession(payload) {
  const code = genCode();
  const row = {
    join_code: code,
    question_text: payload.question,
    question_type: payload.qtype,
    options: payload.qtype === 'multiple_choice' ? payload.options : null,
    presenter_name: payload.presenter || null,
    is_closed: false,
  };
  const { data, error } = await sb.from('sessions').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function loadSession(sessionId) {
  const { data, error } = await sb.from('sessions').select('*').eq('id', sessionId).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadSessionByCode(code) {
  const { data, error } = await sb
    .from('sessions')
    .select('*')
    .eq('join_code', code.toUpperCase())
    .eq('is_closed', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function submitResponse(sessionId, value) {
  const { error } = await sb.from('responses').insert({
    session_id: sessionId,
    response_data: String(value),
  });
  if (error) throw error;
}

async function fetchResponses(sessionId) {
  const { data, error } = await sb
    .from('responses')
    .select('id, response_data, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) return [];
  return data || [];
}

function subscribeResponses(sessionId, onInsert) {
  if (!sb) return;
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb
    .channel('responses-' + sessionId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'responses', filter: `session_id=eq.${sessionId}` },
      payload => onInsert(payload.new))
    .subscribe();
}

async function closeSession(sessionId) {
  await sb.from('sessions').update({ is_closed: true }).eq('id', sessionId);
}

// ---------- Rendering: results ----------

function renderMCResults(responses, options) {
  const counts = Object.fromEntries(options.map(o => [o, 0]));
  responses.forEach(r => {
    if (counts[r.response_data] !== undefined) counts[r.response_data]++;
  });
  const total = responses.length;
  const max = Math.max(1, ...Object.values(counts));
  return options.map(opt => {
    const c = counts[opt];
    const pct = total ? Math.round((c / total) * 100) : 0;
    const widthPct = Math.max(c > 0 ? 2 : 0, Math.round((c / max) * 100));
    return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(opt)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div></div>
        <div class="bar-stats">${c}<span class="pct">${pct}%</span></div>
      </div>
    `;
  }).join('');
}

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','of','to','in','on','for','with','is','it','i','you','we','they',
  'this','that','as','at','be','so','not','no','do','does','if','than','then','there','here','what',
  'how','when','where','why','who','will','would','should','could','can','may','might','just','more',
  'less','most','least','very','too','also','only','own','same','such','into','from','about','over',
  'under','between','through','during','before','after','above','below','up','down','out','off','its',
  'im','ive','id','dont','doesnt','cant','wont','isnt','arent','wasnt','werent','hasnt','havent','hadnt',
]);

function renderCloudResults(responses) {
  const counts = {};
  responses.forEach(r => {
    (r.response_data || '').toLowerCase().split(/[\s,.;:!?'"()\[\]{}—–\-]+/).forEach(w => {
      w = w.trim();
      if (!w || w.length < 2 || STOP_WORDS.has(w)) return;
      counts[w] = (counts[w] || 0) + 1;
    });
  });
  const entries = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 50);
  if (!entries.length) return '<p class="results-empty muted">Waiting for the first response…</p>';

  const max = entries[0][1];
  const positions = placeWordsCloud(entries);

  const spans = entries.map(([word, count], i) => {
    const pos = positions[i];
    const isTop      = i === 0;
    const isHighTier = !isTop && count >= max * 0.5;

    // sqrt scale so very common words don't dwarf everything else
    const sizePx = 14 + Math.sqrt(count / max) * 44; // 14 .. 58

    const weight  = isTop ? 800 : isHighTier ? 700 : 500;
    const color   = isTop ? 'var(--red)' : 'var(--white)';
    const opacity = isTop ? 1 : (isHighTier ? 0.95 : 0.78);
    const zIndex  = isTop ? 5 : 1;

    return `<span class="cloud-word${isTop ? ' tier-1' : ''}"
                  style="left:${pos.x.toFixed(1)}%;top:${pos.y.toFixed(1)}%;font-size:${sizePx.toFixed(0)}px;font-weight:${weight};color:${color};opacity:${opacity};z-index:${zIndex}"
                  data-w="${escapeHtml(word)}"
                  title="${escapeHtml(word)} · ${count} ${count === 1 ? 'vote' : 'votes'}">${escapeHtml(word)}</span>`;
  });

  // Render the top word LAST so it paints on top of any neighbour that
  // might still graze its bounding box even after collision detection.
  if (spans.length > 1) spans.push(spans.shift());
  return spans.join('');
}

// Position words with real bounding-box collision detection and a padding gap.
// Largest words claim the center; smaller words orbit outward along a spiral
// until they find a non-colliding slot. Returns positions in entries order.
function placeWordsCloud(entries) {
  if (!entries.length) return [];

  const container = document.getElementById('results-area');
  if (!container) return entries.map(() => ({ x: 50, y: 50 }));

  const W = container.clientWidth;
  const H = container.clientHeight;
  if (W === 0 || H === 0) return entries.map(() => ({ x: 50, y: 50 }));

  const max = entries[0][1];
  const PAD = 8;          // px breathing room between bounding boxes
  const EDGE = 6;         // px inset from container edges
  const MAX_STEPS = 1500; // spiral search budget per word

  // Build sized entries with font-size/weight per tier.
  const sized = entries.map(([word, count], i) => {
    const isTop      = i === 0;
    const isHighTier = !isTop && count >= max * 0.5;
    const sizePx = 14 + Math.sqrt(count / max) * 44;
    const weight = isTop ? 800 : isHighTier ? 700 : 500;
    return { word, count, isTop, idx: i, sizePx, weight };
  });

  // Measure each word with an offscreen span that mirrors .cloud-word's
  // typography so the bounding box reflects the actual rendered size.
  const measurer = document.createElement('span');
  measurer.style.cssText =
    'position:absolute;visibility:hidden;left:0;top:0;' +
    'white-space:nowrap;font-family:inherit;letter-spacing:0.02em;' +
    'line-height:1.05;padding:2px 8px;';
  container.appendChild(measurer);
  for (const s of sized) {
    measurer.style.fontSize   = s.sizePx + 'px';
    measurer.style.fontWeight = String(s.weight);
    measurer.textContent      = s.word;
    s.w = measurer.offsetWidth;
    s.h = measurer.offsetHeight;
  }
  measurer.remove();

  // Placement priority: largest area first. The top word is the largest,
  // so it gets the dead-center slot first; smaller words fan out from there.
  const queue = [...sized].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const placed = []; // { x, y, w, h } top-left corner in container px

  const fits = (bx, by, bw, bh) => {
    if (bx < EDGE || by < EDGE || bx + bw > W - EDGE || by + bh > H - EDGE) return false;
    for (const p of placed) {
      if (bx       < p.x + p.w + PAD &&
          bx + bw  > p.x - PAD &&
          by       < p.y + p.h + PAD &&
          by + bh  > p.y - PAD) return false;
    }
    return true;
  };

  for (const s of queue) {
    let ok = false;

    // 1. Center slot — top word has natural dibs here.
    const cbx = W / 2 - s.w / 2;
    const cby = H / 2 - s.h / 2;
    if (fits(cbx, cby, s.w, s.h)) {
      s.bx = cbx; s.by = cby;
      placed.push({ x: cbx, y: cby, w: s.w, h: s.h });
      ok = true;
    }

    // 2. Archimedean spiral outward from center, per-word phase offset
    //    so two words never search identical angles.
    if (!ok) {
      const phase = s.idx * 0.9;
      for (let step = 1; step <= MAX_STEPS; step++) {
        const t = step * 0.45;
        const r = t;
        const angle = t + phase;
        const cx = W / 2 + Math.cos(angle) * r;
        const cy = H / 2 + Math.sin(angle) * r;
        const bx = cx - s.w / 2;
        const by = cy - s.h / 2;
        if (fits(bx, by, s.w, s.h)) {
          s.bx = bx; s.by = by;
          placed.push({ x: bx, y: by, w: s.w, h: s.h });
          ok = true;
          break;
        }
      }
    }

    // 3. Couldn't fit. Park off-canvas — better invisible than stomping the
    //    top word.
    if (!ok) { s.bx = -9999; s.by = -9999; }
  }

  // Convert each entry's pixel top-left back to a CENTER position in % so it
  // composes cleanly with .cloud-word's `transform: translate(-50%, -50%)`.
  return sized.map(s => ({
    x: ((s.bx + s.w / 2) / W) * 100,
    y: ((s.by + s.h / 2) / H) * 100,
  }));
}

function renderRatingResults(responses) {
  const counts = [0, 0, 0, 0, 0];
  let total = 0, sum = 0;
  responses.forEach(r => {
    const n = parseInt(r.response_data, 10);
    if (n >= 1 && n <= 5) { counts[n-1]++; total++; sum += n; }
  });
  const avg = total ? (sum / total) : 0;
  const max = Math.max(1, ...counts);
  return `
    <div class="rating-bars">
      ${counts.map((c, i) => `
        <div class="rating-col">
          <div class="rating-col-count">${c}</div>
          <div class="rating-col-fill" style="height:${Math.max(c > 0 ? 4 : 0, Math.round((c/max)*100))}%"></div>
          <div class="rating-col-label">${i+1}</div>
        </div>
      `).join('')}
    </div>
    <div class="rating-avg"><strong>${avg.toFixed(1)}</strong>average across ${total} ${total === 1 ? 'response' : 'responses'}</div>
  `;
}

function renderResults(responses) {
  if (!currentSession) return;
  const area = document.getElementById('results-area');
  const empty = '<p class="results-empty muted">Waiting for the first response…</p>';
  if (!responses.length) { area.innerHTML = empty; return; }
  if (currentSession.question_type === 'multiple_choice') {
    area.innerHTML = renderMCResults(responses, currentSession.options || []);
  } else if (currentSession.question_type === 'word_cloud') {
    area.innerHTML = renderCloudResults(responses);
  } else if (currentSession.question_type === 'rating') {
    area.innerHTML = renderRatingResults(responses);
  }
}

function bumpCount(el) {
  el.classList.remove('bump');
  // force reflow so the animation re-triggers
  void el.offsetWidth;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 400);
}

// ---------- Presenter: create ----------

function wirePresenterCreate() {
  const form = document.getElementById('create-form');
  const optionsField = document.getElementById('options-field');
  const errorEl = document.getElementById('create-error');

  form.querySelectorAll('input[name="qtype"]').forEach(r => {
    r.addEventListener('change', () => {
      const v = document.querySelector('input[name="qtype"]:checked').value;
      optionsField.style.display = v === 'multiple_choice' ? '' : 'none';
    });
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorEl.hidden = true;
    const data = new FormData(form);
    const qtype = data.get('qtype');
    const options = qtype === 'multiple_choice'
      ? data.get('options').split('\n').map(s => s.trim()).filter(Boolean)
      : null;
    if (qtype === 'multiple_choice' && (!options || options.length < 2)) {
      errorEl.textContent = 'Multiple choice needs at least 2 options.';
      errorEl.hidden = false;
      return;
    }
    if (qtype === 'multiple_choice' && options.length > 6) {
      errorEl.textContent = 'Maximum 6 options.';
      errorEl.hidden = false;
      return;
    }

    const btn = document.getElementById('launch-btn');
    btn.disabled = true; btn.textContent = 'Launching…';
    try {
      currentSession = await createSession({
        question: data.get('question').trim(),
        qtype,
        options,
        presenter: data.get('presenter').trim() || null,
      });
      navigate('live');
    } catch (err) {
      errorEl.textContent = 'Could not launch poll: ' + err.message;
      errorEl.hidden = false;
      btn.disabled = false; btn.textContent = 'Launch poll';
    }
  });
}

// ---------- Presenter: live ----------

function setupPresenterLive() {
  if (!currentSession) return;
  document.getElementById('join-code').textContent = currentSession.join_code;
  document.getElementById('question-text').textContent = currentSession.question_text;
  document.getElementById('presenter-by').textContent =
    (currentSession.presenter_name || 'Someone') + ' is asking';

  const baseUrl = location.origin + location.pathname.replace(/presenter\.html.*/, '');
  const audienceUrl = baseUrl + 'audience.html';
  document.getElementById('audience-url').textContent = audienceUrl;
  const qrData = audienceUrl + '#' + currentSession.join_code;
  document.getElementById('qr-img').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=296x296&margin=2&data=${encodeURIComponent(qrData)}`;

  // Initial fetch
  fetchResponses(currentSession.id).then(resps => {
    responseCache = resps;
    renderResults(resps);
  });

  // Realtime subscribe
  subscribeResponses(currentSession.id, row => {
    responseCache.push(row);
    document.getElementById('response-count').textContent = responseCache.length;
    bumpCount(document.getElementById('response-count'));
    renderResults(responseCache);
  });

  document.getElementById('close-btn').addEventListener('click', async () => {
    if (!confirm('Close this poll? Audience can no longer vote.')) return;
    await closeSession(currentSession.id);
    currentSession.is_closed = true;
    const b = document.getElementById('close-btn');
    b.disabled = true; b.textContent = 'Closed';
  });

  document.getElementById('new-btn').addEventListener('click', () => {
    currentSession = null;
    responseCache = [];
    navigate('create');
  });
}

// ---------- Audience: join ----------

function wireAudienceJoin() {
  const form = document.getElementById('join-form');
  const errEl = document.getElementById('join-error');
  const codeInput = document.getElementById('code-input');

  // Auto-uppercase
  codeInput.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  setTimeout(() => codeInput.focus(), 50);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errEl.hidden = true;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      errEl.textContent = 'Code is 4 characters.'; errEl.hidden = false; return;
    }
    const btn = document.getElementById('join-btn');
    btn.disabled = true; btn.textContent = 'Joining…';
    try {
      const session = await loadSessionByCode(code);
      if (!session) {
        errEl.textContent = 'No active poll with that code.';
        errEl.hidden = false;
        btn.disabled = false; btn.textContent = 'Join poll';
        return;
      }
      currentSession = session;
      navigate('vote');
    } catch (err) {
      errEl.textContent = 'Could not join: ' + err.message;
      errEl.hidden = false;
      btn.disabled = false; btn.textContent = 'Join poll';
    }
  });
}

// ---------- Audience: vote ----------

function renderVoteArea() {
  const area = document.getElementById('vote-area');
  area.innerHTML = '';
  if (currentSession.question_type === 'multiple_choice') {
    const opts = currentSession.options || [];
    area.innerHTML = `<div class="vote-mc">${opts.map(o =>
      `<button class="vote-option" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`
    ).join('')}</div>`;
    area.querySelectorAll('.vote-option').forEach(b => {
      b.addEventListener('click', () => doVote(b.dataset.v, b));
    });
  } else if (currentSession.question_type === 'word_cloud') {
    area.innerHTML = `
      <input type="text" class="vote-text-input" id="wc-input" placeholder="Type one word or short phrase" maxlength="40" autocomplete="off" spellcheck="false">
      <button class="btn-primary" id="wc-submit" style="margin-top:14px">Send</button>
    `;
    const inp = document.getElementById('wc-input');
    const sub = document.getElementById('wc-submit');
    const send = () => {
      const v = inp.value.trim();
      if (!v) return;
      doVote(v, sub);
    };
    sub.addEventListener('click', send);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    setTimeout(() => inp.focus(), 50);
  } else if (currentSession.question_type === 'rating') {
    area.innerHTML = `<div class="vote-rating">${[1,2,3,4,5].map(n =>
      `<button data-v="${n}">${n}</button>`
    ).join('')}</div>`;
    area.querySelectorAll('.vote-rating button').forEach(b => {
      b.addEventListener('click', () => doVote(b.dataset.v, b));
    });
  }
}

function setupAudienceVote() {
  if (!currentSession) return;
  document.getElementById('vote-question').textContent = currentSession.question_text;
  document.getElementById('vote-presenter').textContent =
    (currentSession.presenter_name || 'Someone') + ' is asking';
  renderVoteArea();
}

async function doVote(value, btn) {
  if (btn) btn.disabled = true;
  try {
    await submitResponse(currentSession.id, value);
    // Get rank (total responses + 1)
    const resps = await fetchResponses(currentSession.id);
    const rank = resps.length + 1;
    document.getElementById('rank-num').textContent = '#' + rank;
    navigate('thanks');
  } catch (err) {
    alert('Vote failed: ' + err.message);
    if (btn) btn.disabled = false;
  }
}

// ---------- Router / main ----------

function showView(id) {
  document.querySelectorAll('.page-wrap').forEach(el => el.hidden = true);
  const target = document.getElementById(id);
  if (target) target.hidden = false;
}

function deriveView(page, sessionId) {
  const u = new URL(location.href);
  const done = u.searchParams.get('done');
  if (page === 'presenter') return sessionId ? 'live-view' : 'create-view';
  if (page === 'audience') {
    if (!sessionId) return 'join-view';
    if (done === '1') return 'thanks-view';
    return 'vote-view';
  }
  return null;
}

async function render() {
  const page = document.body.dataset.page;
  if (!page) return;
  const sessionId = getSessionIdFromUrl();
  const view = deriveView(page, sessionId);

  if (page === 'presenter') {
    if (view === 'live-view' && sessionId) {
      if (!currentSession || currentSession.id !== sessionId) {
        currentSession = await loadSession(sessionId);
      }
      showView('live-view');
      if (currentSession) setupPresenterLive();
    } else {
      currentSession = null;
      showView('create-view');
      wirePresenterCreate();
    }
  }

  if (page === 'audience') {
    if (view === 'vote-view' && sessionId) {
      if (!currentSession || currentSession.id !== sessionId) {
        currentSession = await loadSession(sessionId);
      }
      if (!currentSession) { navigate('join'); return; }
      if (currentSession.is_closed) {
        alert('This poll is closed.');
        navigate('join');
        return;
      }
      showView('vote-view');
      setupAudienceVote();
    } else if (view === 'thanks-view' && sessionId) {
      if (!currentSession || currentSession.id !== sessionId) {
        currentSession = await loadSession(sessionId);
      }
      showView('thanks-view');
      document.getElementById('vote-again-btn').addEventListener('click', () => {
        navigate('vote');
      });
    } else {
      currentSession = null;
      showView('join-view');
      wireAudienceJoin();
    }
  }
}

window.addEventListener('popstate', render);

document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  render();
});
