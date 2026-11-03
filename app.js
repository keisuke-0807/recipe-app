'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

const CATEGORIES = ['主菜', '副菜', '汁物・スープ', 'ご飯・麺', 'パン', 'お菓子', 'その他'];
const listState = { q: '', cat: '', fav: false, scroll: 0 };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
// 検索用の正規化：全角→半角、大文字→小文字、カタカナ→ひらがな
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
// データの大きさ（UTF-8でのバイト数）と表示用の単位
const jsonBytes = v => (Array.isArray(v) && !v.length ? 0 : new Blob([JSON.stringify(v)]).size);
const fmtSize = b => (b === 0 ? "0KB" : b < 1024 * 1024 ? `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)}KB` : `${(b / 1024 / 1024).toFixed(1)}MB`);
const safeURL = u => /^https?:\/\//i.test(String(u || '').trim());
// 参考URL：旧データ（source: 文字列1つ）と新データ（sources: 配列）の両方に対応
const sourcesOf = r => Array.isArray(r.sources) ? r.sources.filter(u => typeof u === 'string' && u.trim())
  : (typeof r.source === 'string' && r.source.trim() ? [r.source] : []);
// 「cookpad.com/...」のようにスキームが省略されていたら https:// を補う
const normalizeURL = u => {
  u = u.trim();
  return u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && /^[^\s/]+\.[^\s/]+/.test(u) ? `https://${u}` : u;
};
const siteName = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/* ---------- 共通 UI ---------- */
function setHeader({ title = '', back = '', actions = '' }) {
  const b = $('#back');
  b.hidden = !back;
  b.href = back || '#/';
  $('#title').textContent = title;
  $('#actions').innerHTML = actions;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

const photoCache = new Map();
function photoURL(r) {
  if (!r.photo) return '';
  const hit = photoCache.get(r.id);
  if (hit && hit.v === r.updatedAt) return hit.url;
  if (hit) URL.revokeObjectURL(hit.url);
  const url = URL.createObjectURL(r.photo);
  photoCache.set(r.id, { v: r.updatedAt, url });
  return url;
}

const tagsHTML = tags => (tags && tags.length)
  ? `<div class="tags">${tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '';

/* ---------- 分量の換算 ---------- */
function fmtNum(v) {
  const r = Math.round(v * 100) / 100;
  const int = Math.floor(r);
  const dec = Math.round((r - int) * 100) / 100;
  const frac = { 0.25: '1/4', 0.33: '1/3', 0.5: '1/2', 0.67: '2/3', 0.75: '3/4' }[dec];
  if (dec && frac) return int ? `${int}と${frac}` : frac;
  return String(r);
}
// "200g" "大さじ1と1/2" "1/2個" などの数値部分だけを倍率で変換する
function scaleAmount(amount, f) {
  if (f === 1 || !amount) return amount;
  return amount.normalize('NFKC').replace(/(\d+(?:\.\d+)?)(?:と(\d+)\/(\d+)|\/(\d+))?/g, (m, a, b, c, d) => {
    let v = Number(a);
    if (b && c) v += Number(b) / Number(c);
    else if (d) v /= Number(d);
    return fmtNum(v * f);
  });
}

/* ---------- まとめて入力（音声入力・貼り付けの解析） ---------- */
const AMT_SRC = (() => {
  const PREFIX = '(?:各\\s*)?(?:大さじ|小さじ|大匙|小匙|カップ|茶碗|約)';
  const NUM = '(?:各\\s*)?(?:\\d+(?:\\.\\d+)?(?:と\\d+\\/\\d+|\\/\\d+)?|[一二三四五六七八九十百千]+|半)';
  const UNIT = '(?:kg|g|ml|cc|l|個|本|枚|片|かけ|株|束|袋|パック|缶|切れ|玉|房|丁|合|杯|カップ|尾|匹|cm|センチ|グラム|ミリリットル|リットル)';
  const SUFFIX = '半?(?:分|程度|くらい|ぐらい|ほど|強|弱)?';
  const WORD = '各?(?:少々|適量|適宜|少量|ひとつまみ|ひとつかみ|お好みで|好みで)';
  return `(?:${PREFIX}\\s*${NUM}\\s*${UNIT}?${SUFFIX}|${NUM}\\s*${UNIT}${SUFFIX}|半分|\\d+(?:\\.\\d+)?|${WORD})`;
})();
const AMT_RUN = new RegExp(AMT_SRC, 'gi');
const AMT_END = new RegExp(`^(.*?)[\\s:….]*(${AMT_SRC})$`, 'i');
const KANJI_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNIT = { 十: 10, 百: 100, 千: 1000 };
// 「二百五十」→ 250
const kanjiToNum = s => s.replace(/[一二三四五六七八九十百千]+/g, m => {
  let total = 0, digit = 0;
  for (const c of m) {
    if (c in KANJI_DIGIT) digit = KANJI_DIGIT[c];
    else { total += (digit || 1) * KANJI_UNIT[c]; digit = 0; }
  }
  return String(total + digit);
});

// 「じゃがいも2個玉ねぎ1個」のように区切りなしで続く場合、分量の直後で分ける
function splitRuns(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(AMT_RUN)) {
    if (!m[0] || m.index <= last) continue;
    const end = m.index + m[0].length;
    const rest = s.slice(end).trimStart();
    if (rest && !/^[\d/と〜~\-()]/.test(rest) && s.slice(last, m.index).trim()) {
      out.push(s.slice(last, end));
      last = end;
    }
  }
  out.push(s.slice(last));
  return out;
}

// 「じゃがいも2個、玉ねぎ1個、しょうゆ大さじ2」→ [{name, amount}, ...]
function parseIngredients(text) {
  const items = [];
  for (const bigLine of String(text).normalize('NFKC').split(/\r?\n/)) {
    const group = [];
    for (let line of bigLine.split(/[、,。;]/)) {
      line = line.replace(/^[\s・\-*●○◎■□◆◇※>]+/, '').replace(/^\(?\d+[.)]\s+/, '').trim();
      if (!line || /^[【\[(]?(材料|作り方|手順)/.test(line)) continue;
      for (const piece of splitRuns(line)) {
        const p = piece.trim();
        if (!p) continue;
        let name = p, amount = '';
        const m = p.match(AMT_END);
        if (m && m[1].trim()) { name = m[1]; amount = m[2]; }
        else {
          const s = p.match(/^(.+?)[\s:….]+(\S.*)$/);
          if (s) { name = s[1]; amount = s[2]; }
        }
        group.push({ name: name.trim().replace(/を$/, ''), amount: kanjiToNum(amount.trim()) });
      }
    }
    // 「しょうゆ、みりん 各大さじ2」→ 直前の分量なしの材料にも同じ分量を入れる
    for (let i = group.length - 1; i >= 0; i--) {
      if (!group[i].amount.startsWith('各')) continue;
      const amt = group[i].amount.replace(/^各\s*/, '');
      group[i].amount = amt;
      for (let j = i - 1; j >= 0 && !group[j].amount; j--) group[j].amount = amt;
    }
    items.push(...group);
  }
  return items;
}

// 複数行なら1行＝1手順、1行だけ（音声入力など）なら「。」ごとに分ける
function parseSteps(text) {
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const raw = lines.length > 1 ? lines : ((lines[0] || '').match(/[^。]+。?/g) || []);
  return raw
    .map(s => s.replace(/^(?:(?:手順|STEP|ＳＴＥＰ)\s*[0-9０-９]+[.．:：)）]?|[（(]?[0-9０-９]+[.．):）：、]|[①-⑳])\s*/i, '').trim())
    .filter(s => s && s !== '。' && !/^[【\[(（]?(作り方|手順)[】\])）]?$/.test(s));
}

/* ---------- 画像 ---------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}
async function resizeImage(file, max = 1200) {
  const img = await loadImage(file);
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
}
const blobToDataURL = blob => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});

/* ---------- 画面のスリープ防止（調理モード） ---------- */
let wakeLock = null;
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
async function toggleWake(btn) {
  const label = on => { btn.classList.toggle('on', on); btn.textContent = on ? '🔆 調理モード中（タップで解除）' : '🔆 調理モード（画面を消さない）'; };
  if (wakeLock) { releaseWakeLock(); label(false); return; }
  if (!('wakeLock' in navigator)) { toast('この端末では使えません'); return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    label(true);
    wakeLock.addEventListener('release', () => { wakeLock = null; label(false); });
  } catch {
    toast('スリープ防止を開始できませんでした');
  }
}

/* ---------- 一覧 ---------- */
function haystack(r) {
  return norm([r.title, r.category, r.memo, ...(r.tags || []), ...(r.ingredients || []).map(i => i.name)].join(' '));
}
const card = r => `
  <li><a class="card" href="#/r/${encodeURIComponent(r.id)}">
    <div class="thumb">${r.photo ? `<img src="${photoURL(r)}" alt="" loading="lazy">` : '<span>🍽</span>'}</div>
    <div class="info">
      <div class="name">${r.favorite ? '<span class="star">★</span>' : ''}${esc(r.title)}</div>
      <div class="meta">${[r.category, r.time ? `${r.time}分` : ''].filter(Boolean).map(esc).join(' · ')}</div>
      ${tagsHTML(r.tags)}
    </div>
  </a></li>`;

async function renderList() {
  const [all, shop] = await Promise.all([DB.all(), DB.shopping.all()]);
  const toBuy = shop.filter(i => !i.checked).length;
  setHeader({
    title: 'レシピ帳',
    actions: `<a class="icon-btn badge-wrap" href="#/shopping" aria-label="買い物リスト">🛒${toBuy ? `<span class="badge">${toBuy}</span>` : ''}</a>
              <a class="icon-btn" href="#/settings" aria-label="設定">⚙︎</a>`,
  });
  const usedCats = new Set(all.map(r => r.category).filter(Boolean));
  const cats = [...CATEGORIES.filter(c => usedCats.has(c)), ...[...usedCats].filter(c => !CATEGORIES.includes(c))];
  view.innerHTML = `
    <div class="search"><input id="q" type="search" placeholder="料理名・材料・タグで検索" value="${esc(listState.q)}" enterkeyhint="search"></div>
    <div class="chips" id="chips">
      <button class="chip ${!listState.cat && !listState.fav ? 'on' : ''}" data-cat="">すべて</button>
      <button class="chip ${listState.fav ? 'on' : ''}" data-fav="1">★ お気に入り</button>
      ${cats.map(c => `<button class="chip ${listState.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <ul class="cards" id="cards"></ul>
    <a class="fab" href="#/new" aria-label="レシピを追加">＋</a>`;

  const draw = () => {
    const words = norm(listState.q).split(/\s+/).filter(Boolean);
    const list = all
      .filter(r => (!listState.cat || r.category === listState.cat) && (!listState.fav || r.favorite))
      .filter(r => { const h = haystack(r); return words.every(w => h.includes(w)); })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    $('#cards').innerHTML = list.length ? list.map(card).join('')
      : all.length ? '<li class="empty">該当するレシピがありません</li>'
      : `<li class="empty">まだレシピがありません。<br>右下の ＋ から追加しましょう。<br><button class="btn secondary" id="sample">サンプルを1件追加してみる</button></li>`;
    $('#sample')?.addEventListener('click', async () => { await addSample(); renderList(); });
  };
  draw();

  $('#q').addEventListener('input', e => { listState.q = e.target.value; draw(); });
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.fav) { listState.fav = !listState.fav; listState.cat = ''; }
    else { listState.cat = b.dataset.cat; listState.fav = false; }
    $$('.chip').forEach(x => x.classList.toggle('on',
      x.dataset.fav ? listState.fav : (x.dataset.cat === listState.cat && !listState.fav)));
    draw();
  });
}

function addSample() {
  const now = Date.now();
  return DB.put({
    id: uid(), title: '肉じゃが', category: '主菜', servings: 2, time: 30,
    tags: ['和食', '定番'],
    ingredients: [
      { name: '豚こま肉', amount: '150g' }, { name: 'じゃがいも', amount: '2個' },
      { name: '玉ねぎ', amount: '1/2個' }, { name: 'にんじん', amount: '1/2本' },
      { name: '水', amount: '200ml' }, { name: 'しょうゆ', amount: '大さじ2' },
      { name: 'みりん', amount: '大さじ2' }, { name: '砂糖', amount: '大さじ1と1/2' },
    ],
    steps: [
      'じゃがいもは一口大、玉ねぎはくし切り、にんじんは乱切りにする。',
      '鍋に油をひき、豚肉を炒める。色が変わったら野菜を加えて炒める。',
      '水と調味料を入れ、落としぶたをして弱めの中火で15分ほど煮る。',
      'じゃがいもに竹串がすっと通ったら完成。',
    ],
    memo: 'これはサンプルです。編集・削除して自由に使ってください。',
    sources: [], photo: null, favorite: false, createdAt: now, updatedAt: now,
  });
}

/* ---------- 詳細 ---------- */
async function renderDetail(id) {
  const r = await DB.get(id);
  if (!r) { location.replace('#/'); return; }
  setHeader({
    back: '#/',
    actions: `<button class="icon-btn" id="fav" aria-label="お気に入り">${r.favorite ? '★' : '☆'}</button>
              <a class="text-btn" href="#/edit/${encodeURIComponent(r.id)}">編集</a>`,
  });
  const base = Number(r.servings) || 0;
  let servings = base;
  const meta = [r.category, r.time ? `⏱ ${r.time}分` : '', base ? `${base}人分` : ''].filter(Boolean);
  const links = sourcesOf(r).map(u => u.trim()).filter(safeURL);
  view.innerHTML = `
    ${r.photo ? `<img class="hero" src="${photoURL(r)}" alt="">` : ''}
    <article class="detail">
      <h2>${esc(r.title)}</h2>
      ${meta.length ? `<p class="meta">${meta.map(esc).join(' · ')}</p>` : ''}
      ${tagsHTML(r.tags)}
      <div class="section-head">
        <h3>材料</h3>
        ${base ? '<div class="stepper"><button id="minus" aria-label="人数を減らす">−</button><span id="srv"></span><button id="plus" aria-label="人数を増やす">＋</button></div>' : ''}
      </div>
      <ul class="ingredients checklist" id="ing"></ul>
      ${(r.ingredients || []).length ? '<button class="btn secondary wide" id="toShop">🛒 買い物リストに追加</button>' : ''}
      <h3>作り方</h3>
      <ol class="steps checklist">${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('') || '<li class="muted">（未登録）</li>'}</ol>
      ${r.memo ? `<h3>メモ</h3><p class="memo">${esc(r.memo)}</p>` : ''}
      ${links.length ? `<h3>参考</h3><ul class="sources">${links.map(u => `
        <li><a href="${esc(u)}" target="_blank" rel="noopener"><span class="site">🔗 ${esc(siteName(u))}</span><span class="url">${esc(u)}</span></a></li>`).join('')}</ul>` : ''}
      <p class="hint">材料や手順はタップするとチェックできます</p>
      <button class="btn secondary wide" id="wake">🔆 調理モード（画面を消さない）</button>
    </article>`;

  const drawIng = () => {
    const f = base ? servings / base : 1;
    if (base) $('#srv').textContent = `${servings}人分`;
    $('#ing').innerHTML = (r.ingredients || []).map(i =>
      `<li><span>${esc(i.name)}</span><span class="amt">${esc(scaleAmount(i.amount, f))}</span></li>`).join('')
      || '<li class="muted">（未登録）</li>';
  };
  drawIng();

  $('#minus')?.addEventListener('click', () => { servings = Math.max(1, servings - 1); drawIng(); });
  $('#plus')?.addEventListener('click', () => { servings = Math.min(99, servings + 1); drawIng(); });
  $('.detail').addEventListener('click', e => {
    const li = e.target.closest('.checklist li');
    if (li && !li.classList.contains('muted')) li.classList.toggle('done');
  });
  $('#fav').addEventListener('click', async e => {
    r.favorite = !r.favorite;
    await DB.put(r);
    e.currentTarget.textContent = r.favorite ? '★' : '☆';
    toast(r.favorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
  });
  $('#wake').addEventListener('click', e => toggleWake(e.currentTarget));
  $('#toShop')?.addEventListener('click', async () => {
    const existing = (await DB.shopping.all()).filter(i => i.recipeId === r.id && !i.checked);
    if (existing.length && !confirm('このレシピの材料はすでに買い物リストに入っています。\nもう一度追加しますか？')) return;
    const f = base ? servings / base : 1;
    const now = Date.now();
    const items = (r.ingredients || []).filter(i => i.name);
    await Promise.all(items.map((i, n) => DB.shopping.put({
      id: uid(), name: i.name, amount: scaleAmount(i.amount, f),
      recipeId: r.id, recipeTitle: r.title, checked: false, createdAt: now + n,
    })));
    toast(`${items.length}件を買い物リストに追加しました`);
  });
}

/* ---------- 買い物リスト ---------- */
async function renderShopping() {
  setHeader({ title: '買い物リスト', back: '#/' });
  view.innerHTML = `
    <form class="shop-add" id="addForm" autocomplete="off">
      <input id="newName" placeholder="品名を追加（例：牛乳）" enterkeyhint="done">
      <button class="btn primary" type="submit">追加</button>
    </form>
    <ul class="shop" id="shop"></ul>
    <div class="shop-actions" id="shopActions"></div>`;
  let items = await DB.shopping.all();

  const draw = () => {
    items.sort((a, b) => (a.checked - b.checked) || (a.createdAt - b.createdAt));
    const left = items.filter(i => !i.checked).length;
    $('#shop').innerHTML = items.length ? items.map(i => `
      <li class="shop-item ${i.checked ? 'done' : ''}" data-id="${esc(i.id)}">
        <span class="box" aria-hidden="true">${i.checked ? '✓' : ''}</span>
        <div class="txt">
          <div class="line"><span class="nm">${esc(i.name)}</span>${i.amount ? `<span class="amt">${esc(i.amount)}</span>` : ''}</div>
          ${i.recipeTitle ? `<div class="from">${esc(i.recipeTitle)}</div>` : ''}
        </div>
        <button class="icon-btn del" aria-label="削除">×</button>
      </li>`).join('')
      : '<li class="empty">買い物リストは空です。<br>レシピの「🛒 買い物リストに追加」か、上の欄から追加できます。</li>';
    $('#shopActions').innerHTML = items.length ? `
      <p class="muted small">残り ${left} 件 / 全 ${items.length} 件</p>
      ${items.length - left ? '<button class="btn secondary wide" id="clearDone">チェック済みを削除</button>' : ''}
      <button class="btn danger wide" id="clearAll">すべて削除</button>` : '';
  };
  draw();

  $('#addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#newName');
    const name = input.value.trim();
    if (!name) return;
    const item = { id: uid(), name, amount: '', recipeId: '', recipeTitle: '', checked: false, createdAt: Date.now() };
    await DB.shopping.put(item);
    items.push(item);
    input.value = '';
    draw();
    input.focus();
  });

  $('#shop').addEventListener('click', async e => {
    const li = e.target.closest('.shop-item');
    if (!li) return;
    const item = items.find(i => i.id === li.dataset.id);
    if (!item) return;
    if (e.target.closest('.del')) {
      await DB.shopping.del(item.id);
      items = items.filter(i => i !== item);
    } else {
      item.checked = !item.checked;
      await DB.shopping.put(item);
    }
    draw();
  });

  $('#shopActions').addEventListener('click', async e => {
    let targets;
    if (e.target.id === 'clearDone') targets = items.filter(i => i.checked);
    else if (e.target.id === 'clearAll') {
      if (!confirm('買い物リストをすべて削除しますか？')) return;
      targets = items;
    } else return;
    await Promise.all(targets.map(i => DB.shopping.del(i.id)));
    items = items.filter(i => !targets.includes(i));
    draw();
  });
}

/* ---------- 編集 ---------- */
// フォントに依存しないよう SVG で描く（上向き矢印＋線＝上とまとめる）
const ICON_MERGE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14M12 20V9M7 13l5-5 5 5"/></svg>';
const ingRow = (i = {}) => `
  <div class="row ing">
    <input class="name" placeholder="材料" value="${esc(i.name)}" enterkeyhint="next">
    <input class="amount" placeholder="分量" value="${esc(i.amount)}" enterkeyhint="next">
    <button type="button" class="icon-btn del" aria-label="削除">×</button>
  </div>`;
const stepRow = (s = '') => `
  <div class="row step">
    <span class="num"></span>
    <textarea rows="2" placeholder="手順">${esc(s)}</textarea>
    <div class="ops">
      <button type="button" class="icon-btn up" aria-label="上へ">↑</button>
      <button type="button" class="icon-btn down" aria-label="下へ">↓</button>
      <button type="button" class="icon-btn merge" aria-label="上の手順とまとめる" title="上とまとめる">${ICON_MERGE}</button>
      <button type="button" class="icon-btn del" aria-label="削除">×</button>
    </div>
  </div>`;

const urlRow = (u = '') => `
  <div class="row url">
    <input class="url" type="url" inputmode="url" placeholder="https://..." value="${esc(u)}">
    <button type="button" class="icon-btn del" aria-label="削除">×</button>
  </div>`;

const bulkPanel = (kind, placeholder, help, applyLabel, oneLabel = '') => `
  <div class="bulk" id="bulk-${kind}" hidden>
    <textarea rows="4" placeholder="${esc(placeholder)}"></textarea>
    <p class="muted small">${esc(help)}</p>
    <div class="bulk-actions">
      <button type="button" class="btn secondary" data-bulk-cancel>やめる</button>
      ${oneLabel ? `<button type="button" class="btn secondary" data-bulk-apply="${kind}" data-mode="one">${esc(oneLabel)}</button>` : ''}
      <button type="button" class="btn primary" data-bulk-apply="${kind}">${esc(applyLabel)}</button>
    </div>
  </div>`;

async function renderEdit(id) {
  const r = id ? await DB.get(id) : null;
  if (id && !r) { location.replace('#/'); return; }
  const d = r || { title: '', category: '', servings: 2, time: '', tags: [], ingredients: [{}, {}, {}], steps: ['', ''], memo: '' };
  const srcs = r ? sourcesOf(r) : [];
  let photo = r?.photo || null;
  let previewURL = '';

  setHeader({
    title: r ? 'レシピを編集' : '新しいレシピ',
    back: r ? `#/r/${encodeURIComponent(r.id)}` : '#/',
    actions: '<button class="text-btn strong" id="saveTop">保存</button>',
  });
  const catOptions = [...CATEGORIES, ...(d.category && !CATEGORIES.includes(d.category) ? [d.category] : [])];
  view.innerHTML = `
    <form class="edit" id="form" novalidate autocomplete="off">
      <div class="photo-pick" id="photoPick" role="button" tabindex="0" aria-label="写真を選ぶ"></div>
      <input type="file" accept="image/*" id="photoInput" hidden>
      <label class="field"><span>料理名 <em>*</em></span><input name="title" value="${esc(d.title)}" placeholder="例：肉じゃが"></label>
      <div class="row3">
        <label class="field"><span>カテゴリ</span>
          <select name="category"><option value="">なし</option>${catOptions.map(c => `<option ${c === d.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>何人分</span><input name="servings" type="number" inputmode="numeric" min="1" value="${esc(d.servings)}"></label>
        <label class="field"><span>時間(分)</span><input name="time" type="number" inputmode="numeric" min="0" value="${esc(d.time)}"></label>
      </div>
      <label class="field"><span>タグ（スペース区切り）</span><input name="tags" value="${esc((d.tags || []).join(' '))}" placeholder="例：和食 作り置き 簡単"></label>
      <fieldset>
        <legend>材料</legend>
        <div id="ingRows">${(d.ingredients.length ? d.ingredients : [{}]).map(ingRow).join('')}</div>
        <div class="fs-actions">
          <button type="button" class="btn secondary" id="addIng">＋ 材料を追加</button>
          <button type="button" class="btn secondary" data-bulk="ing">🎤 まとめて入力</button>
        </div>
        ${bulkPanel('ing', '例：じゃがいも2個、玉ねぎ1個、しょうゆ大さじ2', '「、」や改行で区切ると、材料ごとに分かれます。キーボードの🎤で話してもOKです。', '材料に追加')}
      </fieldset>
      <fieldset>
        <legend>作り方</legend>
        <div id="stepRows">${(d.steps.length ? d.steps : ['']).map(stepRow).join('')}</div>
        <div class="fs-actions">
          <button type="button" class="btn secondary" id="addStep">＋ 手順を追加</button>
          <button type="button" class="btn secondary" data-bulk="step">🎤 まとめて入力</button>
        </div>
        ${bulkPanel('step', '例：じゃがいもを一口大に切る。鍋で炒める。水を入れて15分煮る。',
          '「手順に分けて追加」は「。」ごとに分けます。改行があるときは1行＝1手順になり、「。」では分けません（音声入力では「かいぎょう」で改行）。全部を1つの手順にしたいときは「1つの手順として追加」を押してください。',
          '手順に分けて追加', '1つの手順として追加')}
      </fieldset>
      <label class="field"><span>メモ</span><textarea name="memo" rows="3" placeholder="コツ・アレンジなど">${esc(d.memo)}</textarea></label>
      <fieldset>
        <legend>参考URL</legend>
        <div id="urlRows">${(srcs.length ? srcs : ['']).map(urlRow).join('')}</div>
        <div class="fs-actions"><button type="button" class="btn secondary" id="addUrl">＋ URLを追加</button></div>
      </fieldset>
      <button class="btn primary wide" type="submit">保存</button>
      ${r ? '<button type="button" class="btn danger wide" id="delete">このレシピを削除</button>' : ''}
    </form>`;

  const form = $('#form');
  const drawPhoto = () => {
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = photo ? URL.createObjectURL(photo) : '';
    $('#photoPick').innerHTML = photo
      ? `<img src="${previewURL}" alt=""><button type="button" class="photo-remove" id="photoRemove">写真を削除</button>`
      : '<span>📷<br>写真を追加</span>';
  };
  drawPhoto();

  $('#photoPick').addEventListener('click', e => {
    if (e.target.id === 'photoRemove') { photo = null; drawPhoto(); return; }
    $('#photoInput').click();
  });
  $('#photoInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { photo = await resizeImage(file); drawPhoto(); }
    catch (err) { toast(err.message); }
  });

  const addRow = (container, html) => {
    container.insertAdjacentHTML('beforeend', html);
    container.lastElementChild.querySelector('input, textarea').focus();
  };
  $('#addIng').addEventListener('click', () => addRow($('#ingRows'), ingRow()));
  $('#addStep').addEventListener('click', () => addRow($('#stepRows'), stepRow()));
  $('#addUrl').addEventListener('click', () => addRow($('#urlRows'), urlRow()));

  const applyBulk = (kind, mode) => {
    const panel = $(`#bulk-${kind}`);
    const ta = $('textarea', panel);
    const isIng = kind === 'ing';
    let parsed;
    if (isIng) parsed = parseIngredients(ta.value);
    else if (mode === 'one') {
      // 区切らずに丸ごと1つの手順にする（改行は詰める）
      const one = ta.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('');
      parsed = one ? [one] : [];
    } else parsed = parseSteps(ta.value);
    if (!parsed.length) { toast(isIng ? '材料が見つかりませんでした' : '手順が見つかりませんでした'); return; }
    // 空の行は取り除いてから、解析結果を末尾に追加する
    if (isIng) $$('.row.ing').filter(x => !$('.name', x).value.trim() && !$('.amount', x).value.trim()).forEach(x => x.remove());
    else $$('.row.step').filter(x => !$('textarea', x).value.trim()).forEach(x => x.remove());
    $(isIng ? '#ingRows' : '#stepRows').insertAdjacentHTML('beforeend', parsed.map(isIng ? ingRow : stepRow).join(''));
    ta.value = '';
    panel.hidden = true;
    toast(`${parsed.length}件の${isIng ? '材料' : '手順'}を追加しました`);
  };

  form.addEventListener('click', e => {
    const open = e.target.closest('[data-bulk]');
    if (open) {
      const panel = $(`#bulk-${open.dataset.bulk}`);
      panel.hidden = !panel.hidden;
      if (!panel.hidden) $('textarea', panel).focus();
      return;
    }
    if (e.target.closest('[data-bulk-cancel]')) {
      const panel = e.target.closest('.bulk');
      $('textarea', panel).value = '';
      panel.hidden = true;
      return;
    }
    const apply = e.target.closest('[data-bulk-apply]');
    if (apply) { applyBulk(apply.dataset.bulkApply, apply.dataset.mode); return; }

    const row = e.target.closest('.row');
    if (!row) return;
    if (e.target.closest('.merge')) {
      const prev = row.previousElementSibling;
      if (!prev) return;
      const pt = $('textarea', prev), a = pt.value.trim(), b = $('textarea', row).value.trim();
      // 上の手順が句点などで終わっていなければ「。」を補ってつなげる
      pt.value = a && b && !/[。．.!！?？]$/.test(a) ? `${a}。${b}` : a + b;
      row.remove();
      toast('上の手順とまとめました');
    }
    else if (e.target.closest('.del')) row.remove();
    else if (e.target.closest('.up') && row.previousElementSibling) row.after(row.previousElementSibling);
    else if (e.target.closest('.down') && row.nextElementSibling) row.before(row.nextElementSibling);
  });
  // 材料欄で Enter → 次の欄 / 最後なら行を追加
  form.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.closest('.row.ing')) return;
    e.preventDefault();
    const row = e.target.closest('.row');
    if (e.target.classList.contains('name')) { $('.amount', row).focus(); return; }
    if (row.nextElementSibling) $('.name', row.nextElementSibling).focus();
    else addRow($('#ingRows'), ingRow());
  });

  const save = async () => {
    const fd = new FormData(form);
    const title = fd.get('title').trim();
    if (!title) { toast('料理名を入力してください'); form.title.focus(); return; }
    const now = Date.now();
    const rec = {
      ...(r || {}),
      id: r?.id || uid(),
      title,
      category: fd.get('category'),
      servings: Number(fd.get('servings')) || '',
      time: Number(fd.get('time')) || '',
      tags: [...new Set(fd.get('tags').split(/[\s,、，]+/).map(t => t.replace(/^[#＃]/, '')).filter(Boolean))],
      ingredients: $$('.row.ing').map(x => ({ name: $('.name', x).value.trim(), amount: $('.amount', x).value.trim() }))
        .filter(i => i.name || i.amount),
      steps: $$('.row.step textarea').map(t => t.value.trim()).filter(Boolean),
      memo: fd.get('memo').trim(),
      sources: [...new Set($$('.row.url input').map(i => normalizeURL(i.value)).filter(Boolean))],
      photo,
      favorite: r?.favorite || false,
      createdAt: r?.createdAt || now,
      updatedAt: now,
    };
    delete rec.source; // 旧形式のフィールドは sources に移行済み
    try {
      await DB.put(rec);
    } catch (err) {
      toast('保存に失敗しました: ' + err.message);
      return;
    }
    if (previewURL) URL.revokeObjectURL(previewURL);
    toast('保存しました');
    location.replace(`#/r/${encodeURIComponent(rec.id)}`);
  };
  form.addEventListener('submit', e => { e.preventDefault(); save(); });
  $('#saveTop').addEventListener('click', save);

  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`「${r.title}」を削除しますか？\nこの操作は取り消せません。`)) return;
    await DB.del(r.id);
    const hit = photoCache.get(r.id);
    if (hit) { URL.revokeObjectURL(hit.url); photoCache.delete(r.id); }
    toast('削除しました');
    location.replace('#/');
  });
}

/* ---------- 設定・バックアップ ---------- */
async function exportData() {
  const [all, shopping] = await Promise.all([DB.all(), DB.shopping.all()]);
  const recipes = await Promise.all(all.map(async r => ({ ...r, photo: r.photo ? await blobToDataURL(r.photo) : null })));
  const json = JSON.stringify({ app: 'recipe-book', version: 2, exportedAt: new Date().toISOString(), recipes, shopping });
  const name = `recipes-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });
  // iPhone では共有シート経由で「ファイルに保存」できるようにする
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'レシピのバックアップ' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { throw new Error('JSONファイルとして読み込めませんでした'); }
  const list = Array.isArray(data) ? data : data?.recipes;
  if (!Array.isArray(list)) throw new Error('バックアップファイルの形式が正しくありません');
  let n = 0;
  for (const x of list) {
    if (!x || typeof x.title !== 'string' || !x.title.trim()) continue;
    const photo = typeof x.photo === 'string' && x.photo.startsWith('data:image/')
      ? await (await fetch(x.photo)).blob() : null;
    const rec = {
      ...x,
      id: x.id || uid(),
      sources: sourcesOf(x),
      tags: Array.isArray(x.tags) ? x.tags : [],
      ingredients: Array.isArray(x.ingredients) ? x.ingredients : [],
      steps: Array.isArray(x.steps) ? x.steps : [],
      photo,
      createdAt: x.createdAt || Date.now(),
      updatedAt: x.updatedAt || Date.now(),
    };
    delete rec.source;
    await DB.put(rec);
    n++;
  }
  let s = 0;
  for (const x of Array.isArray(data?.shopping) ? data.shopping : []) {
    if (!x || typeof x.name !== 'string' || !x.name.trim()) continue;
    await DB.shopping.put({
      id: x.id || uid(), name: x.name, amount: String(x.amount ?? ''),
      recipeId: x.recipeId || '', recipeTitle: x.recipeTitle || '',
      checked: !!x.checked, createdAt: x.createdAt || Date.now(),
    });
    s++;
  }
  return { recipes: n, shopping: s };
}

// バージョンは sw.js が作るキャッシュの名前（recipe-book-v<番号>）から読み取る
const CACHE_PREFIX = 'recipe-book-v'; // sw.js と同じ
async function appVersion() {
  try {
    const nums = (await caches.keys()).filter(k => k.startsWith(CACHE_PREFIX)).map(k => Number(k.slice(CACHE_PREFIX.length))).filter(Number.isFinite);
    return nums.length ? String(Math.max(...nums)) : '-';
  } catch { return '-'; }
}

async function renderSettings() {
  setHeader({ title: '設定・バックアップ', back: '#/' });
  const ver = await appVersion();
  const [all, shop] = await Promise.all([DB.all(), DB.shopping.all()]);
  // 使用容量：保存している文字データ（JSON換算）と写真の大きさを合計する
  const textBytes = all.reduce((a, r) => a + jsonBytes({ ...r, photo: null }), 0);
  const photos = all.filter(r => r.photo);
  const photoBytes = photos.reduce((a, r) => a + (r.photo.size || 0), 0);
  const totalBytes = textBytes + photoBytes + jsonBytes(shop);
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  view.innerHTML = `
    <section class="settings">
      <div class="box">
        <h3>バックアップ</h3>
        <p class="usage">使用容量：約 ${fmtSize(totalBytes)}</p>
        <p class="muted small">（レシピ ${all.length}件 約${fmtSize(textBytes)} ／ 写真 ${photos.length}枚 約${fmtSize(photoBytes)} ／ 買い物リスト ${shop.length}件）</p>
        <p class="muted">レシピはこの端末の中だけに保存されています。ときどき書き出して、「ファイル」アプリ（iCloud Drive など）に保存しておくと安心です。</p>
        <button class="btn primary wide" id="export">バックアップを書き出す</button>
        <button class="btn secondary wide" id="importBtn">バックアップから読み込む</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden>
        <p class="muted small">読み込むと、同じレシピは上書きされます。それ以外のレシピはそのまま残ります。</p>
      </div>
      <div class="box">
        <h3>保存の状態</h3>
        <p class="muted">${persisted ? '✅ 永続保存が有効です' : 'ホーム画面に追加して使うと、データが自動で消えにくくなります。'}</p>
      </div>
      <div class="box">
        <h3>アプリについて</h3>
        <p class="muted">バージョン ${esc(ver)}</p>
        <button class="btn secondary wide" id="checkUpdate">更新を確認</button>
      </div>
      <div class="box">
        <h3>iPhoneへの入れ方</h3>
        <p class="muted">SafariでこのページのURLを開き、共有ボタン（□↑）→「ホーム画面に追加」をタップします。</p>
      </div>
    </section>`;
  $('#checkUpdate').addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) { toast('この環境では更新の確認ができません'); return; }
    try { await reg.update(); } catch { toast('確認できませんでした（オフラインかもしれません）'); return; }
    toast(reg.installing || reg.waiting ? '新しいバージョンを準備しています…' : '最新版です');
  });
  $('#export').addEventListener('click', () => exportData().catch(e => toast('書き出しに失敗しました: ' + e.message)));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const n = await importData(file);
      toast(`レシピ${n.recipes}件${n.shopping ? `・買い物リスト${n.shopping}件` : ''}を読み込みました`);
      renderSettings();
    } catch (err) {
      toast(err.message);
    }
  });
}

/* ---------- ルーティング ---------- */
let current = '';
async function route() {
  if (current === 'list') listState.scroll = window.scrollY;
  releaseWakeLock();
  const [, page = '', id = ''] = (location.hash.slice(1) || '/').split('/');
  current = page || 'list';
  try {
    if (!page) { await renderList(); window.scrollTo(0, listState.scroll); return; }
    window.scrollTo(0, 0);
    if (page === 'r') return await renderDetail(decodeURIComponent(id));
    if (page === 'edit') return await renderEdit(decodeURIComponent(id));
    if (page === 'new') return await renderEdit(null);
    if (page === 'settings') return await renderSettings();
    if (page === 'shopping') return await renderShopping();
    location.replace('#/');
  } catch (err) {
    console.error(err);
    view.innerHTML = `<p class="empty">エラーが発生しました：${esc(err.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
route();

/* ---------- 更新の確認とお知らせ ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // すでに古いバージョンで動いていた場合だけ「更新」を知らせる（初回インストール時は出さない）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('#updateBar').hidden = false;
  });
  $('#updateNow').addEventListener('click', () => location.reload());
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    // ホーム画面アプリはバックグラウンドから戻っても再読み込みされないので、戻ったときにも確認する
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(err => console.warn('SW登録失敗', err));
}
navigator.storage?.persist?.().catch(() => {});
