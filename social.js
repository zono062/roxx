/* ============================================================
   ROXX / コミュニティ（Instagram型の構成）

   下部タブ：ホーム / さがす / プログラム / DM / 自分
   ログイン済みならタブがアプリの外枠になり、診断は「プログラム」タブの中身になる。

   * 権限判定はサーバーのRLSに任せる。ここでの絞り込みは表示の都合であって
     防壁ではない。フォロー外の投稿はそもそも返ってこない。
   * ストーリーとフィード画像は非公開バケットに置き、署名付きURLで読む。
   * 通報・ブロックは App Store ガイドライン1.2 の要件。全画面から到達できる。
   ============================================================ */

const elx = id => document.getElementById(id);
const STORY_BUCKET = "stories";

const RECO_LIMIT = 12;      // レコメンドの最大件数

let TAB = "home";
let FOLLOWING = [];
let STORIES = [];
let POSTS = [];             // フォロー中の投稿
let RECO = [];              // おすすめ（フォローしていない人の公開投稿）
let THREADS = [];
let OPEN_THREAD = null;
let MY_POSTS = [];
let CP_MODE = "card";   // card=結果カード / photo=自分の写真 / text=テキストだけ
let STORY_IX = 0;
let STORY_TIMER = null;

/* ---------- シェル ----------
   ログイン済みならアプリの外枠はタブになる。診断は「プログラム」タブの中身。
   診断がまだの人はフィードが空なので、プログラムから開く。 */
function goToLogin() { goTab("login") }

let PTR_READY = false;
function initPullToRefresh() {
  if (PTR_READY) return;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (!standalone) return;
  PTR_READY = true;
  const badge = document.createElement("div");
  badge.className = "ptr"; badge.textContent = "↓ 引っ張って更新";
  document.body.appendChild(badge);
  let startY = null, pulled = 0;
  const TH = 70;
  window.addEventListener("touchstart", e => {
    const onFeed = document.getElementById("s-social")?.classList.contains("on") && ["home", "me"].includes(TAB);
    startY = (onFeed && window.scrollY <= 0) ? e.touches[0].clientY : null;
  }, { passive: true });
  window.addEventListener("touchmove", e => {
    if (startY === null) return;
    pulled = Math.max(0, e.touches[0].clientY - startY);
    const y = Math.min(pulled, TH + 20) - 60;
    badge.style.transform = `translate(-50%, ${y}px)`;
    badge.textContent = pulled > TH ? "↻ 離して更新" : "↓ 引っ張って更新";
  }, { passive: true });
  window.addEventListener("touchend", () => {
    if (startY !== null && pulled > TH) { badge.textContent = "更新しています…"; goTab(TAB) }
    startY = null; pulled = 0;
    setTimeout(() => { badge.style.transform = "translate(-50%, -60px)" }, 400);
  });
}

/* ログインは独立した1画面にする（インスタ・Threadsと同じ扱い）。
   下部に常設しない。診断は未ログインでも使えるので program だけは開放。 */
function renderLogin() {
  const gear = elx("soGear"); if (gear) gear.hidden = true;
  elx("soView").innerHTML = `
    <div class="loginwrap">
      <div class="loginlogo">ROXX</div>
      <p class="loginlead">記録を残して、同じ大会を目指す人とつながる。</p>
      <div id="acct"></div>
    </div>`;
  if (typeof paintAccount === "function") paintAccount();
}

function enterShell() {
  // 未ログインでもタブUIを外枠にする。診断は「プログラム」タブの中身。
  document.body.classList.add("hastab");
  const signedIn = !!(sb && ME && MY_PROFILE);
  if (typeof routeFromHash === "function" && routeFromHash()) return;
  goTab(signedIn ? "home" : "program");
  if (signedIn) initPullToRefresh();
}
function leaveShell() {
  document.body.classList.remove("hastab");
  stopStory();
  show("s-intro");
}
/* 旧導線からの呼び出しを受ける */
function openSocial() {
  if (!sb || !ME || !MY_PROFILE) { alert("先にアカウントを作成してください"); return }
  enterShell();
  if (typeof track === "function") track("social_open");
}
function closeSocial() { goTab("program") }

function goTab(t) {
  TAB = t;
  const gear0 = elx("soGear"); if (gear0) gear0.hidden = (t !== "me");
  document.querySelectorAll(".tabbtn").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  stopStory();
  window.scrollTo(0, 0);

  if (t === "program") {          // 診断とトレーニング
    show(R ? "s-res" : "s-intro");
    if (typeof track === "function") track("tab_program");
    return;
  }
  show("s-social");
  const v = elx("soView");
  if (t !== "cal" && t !== "login" && (!sb || !ME || !MY_PROFILE)) {
    renderLogin();
    return;
  }
  const sub = elx("soTopSub");
  if (sub) sub.textContent = { home: "", find: "さがす", dm: "メッセージ", me: MY_PROFILE ? "@" + MY_PROFILE.handle : "" }[t] || "";
  if (t === "home") { v.innerHTML = skeleton("読み込んでいます…"); loadHome(); loadNotifs() }
  if (t === "login") { renderLogin(); return }
  if (t === "cal")  { if (typeof renderCalendar === "function") renderCalendar(); return }
  if (t === "find") renderFind();
  if (t === "post") renderCompose();
  if (t === "dm")   { v.innerHTML = skeleton("読み込んでいます…"); loadThreads() }
  if (t === "me")   renderMe();
}
const skeleton = t => `<p class="somsg">${t}</p>`;

/* ---------- ホーム ----------
   フォロー中の投稿と、フォローしていない人の公開投稿（おすすめ）を分けて読む。
   おすすめは同じ大会を目標にしている人を優先する。ROXXは全員の目標レースを
   知っているので、フォロー0でもフィードが空にならない。 */
const POST_COLS = "id,author_id,image_path,caption,created_at,visibility,race";

async function loadHome() {
  // 取得に失敗したとき、読み込み表示のまま固まらないようにする
  try {
    await loadHomeInner();
  } catch (e) {
    console.error("loadHome failed", e);
    const v = document.getElementById("soView");
    if (v) v.innerHTML = `<p class="somsg">読み込めませんでした。通信状況をご確認のうえ、もう一度お試しください。</p>`;
  }
}

async function loadHomeInner() {
  await loadFollowing();
  const now = new Date().toISOString();
  const followIds = FOLLOWING.map(f => f.id);
  const mine = [ME.id, ...followIds];

  const [{ data: st }, { data: ps }, { data: rc }] = await Promise.all([
    sb.from("stories").select("id,author_id,image_path,caption,created_at,expires_at")
      .gt("expires_at", now).order("created_at", { ascending: false }).limit(50),
    sb.from("posts").select(POST_COLS)
      .in("author_id", mine)
      .order("created_at", { ascending: false }).limit(30),
    sb.from("posts").select(POST_COLS)
      .eq("visibility", "public")
      .not("author_id", "in", `(${mine.join(",")})`)
      .order("created_at", { ascending: false }).limit(60)
  ]);

  STORIES = st || [];
  POSTS = ps || [];
  RECO = rankReco(rc || []).slice(0, RECO_LIMIT);

  const all = [...STORIES, ...POSTS, ...RECO];
  const who = await profilesByIds([...new Set(all.map(x => x.author_id))]);
  all.forEach(x => { x.author = who[x.author_id] || { display_name: "利用者", handle: "" } });

  await Promise.all(all.map(async x => {
    if (x.image_path) x.url = await signed(x.image_path);
  }));

  await attachLikes([...POSTS, ...RECO]);
  renderHome();
}

/* 同じ目標レースを先に。次に新しい順 */
function rankReco(rows) {
  const myRace = (typeof A === "object" && A) ? A.race : null;
  return [...rows].sort((a, b) => {
    const am = myRace && a.race === myRace ? 0 : 1;
    const bm = myRace && b.race === myRace ? 0 : 1;
    if (am !== bm) return am - bm;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

async function attachLikes(list) {
  if (!list.length) return;
  const { data: likes } = await sb.from("post_likes").select("post_id,user_id")
    .in("post_id", list.map(p => p.id));
  list.forEach(p => {
    const rows = (likes || []).filter(l => l.post_id === p.id);
    p.likes = rows.length;
    p.liked = rows.some(l => l.user_id === ME.id);
  });
}

function renderHome() {
  // ストーリーは作者ごとにまとめる（インスタと同じく1人1つの輪）
  const byAuthor = [];
  STORIES.forEach(s => {
    let g = byAuthor.find(g => g.id === s.author_id);
    if (!g) { g = { id: s.author_id, author: s.author, items: [] }; byAuthor.push(g) }
    g.items.push(s);
  });
  const mineFirst = byAuthor.sort((a, b) => (a.id === ME.id ? -1 : b.id === ME.id ? 1 : 0));

  const ring = mineFirst.map((g, i) => `
    <button class="ring" onclick="openStoryGroup(${i})">
      <span class="ringimg">${avatarImg(g.author, 56)}</span>
      <span class="ringname">${g.id === ME.id ? "自分" : escHtml(g.author.display_name)}</span>
    </button>`).join("");

  const myRace = (typeof A === "object" && A && A.race && typeof RACES === "object")
    ? (RACES[A.race] || {}).label : null;

  const following = POSTS.length
    ? POSTS.map(p => postCard(p, false)).join("")
    : (RECO.length
        ? `<p class="somsg">フォロー中の人の投稿はまだありません。下の「おすすめ」から気になる人をフォローしてください。</p>`
        : `<div class="guestpane">
             <p class="guestlead">まだ投稿がありません。</p>
             <p class="guestsub">今日のトレーニングを載せると、同じ大会を目指す人に届きます。</p>
             <button class="btn" onclick="openCompose()">最初の投稿をする</button>
           </div>`);

  const reco = RECO.length ? `
    <div class="recohd">
      <b>おすすめ</b>
      <span>${myRace ? myRace + "を目標にしている人から" : "フォローしていない人の公開投稿"}</span>
    </div>
    ${RECO.map(p => postCard(p, true)).join("")}` : "";

  elx("soView").innerHTML = `
    <div class="storystrip">
      <button class="ring add" onclick="openCompose()">
        <span class="ringimg plus">＋</span><span class="ringname">投稿</span>
      </button>
      ${ring}
    </div>
    <div class="feed">${following}${reco}</div>`;
}

function postCard(p, isReco) {
  const sameRace = isReco && typeof A === "object" && A && p.race && p.race === A.race;
  return `
    <article class="post${isReco ? " reco" : ""}${p.url ? "" : " textpost"}">
      <header class="posthd">
        <div class="pauthor">
          ${avatarImg(p.author, 32)}
          <div>
            <b>${escHtml(p.author.display_name)}</b>
            <span>${ago(p.created_at)}${sameRace ? " ・ 同じ大会" : ""}</span>
          </div>
        </div>
        ${isReco
          ? `<button class="sobtn sm" onclick="follow('${p.author_id}')">フォロー</button>`
          : `<button class="solink" onclick="postMenu('${p.id}','${p.author_id}')">…</button>`}
      </header>
      ${p.url ? `<img class="postimg" src="${p.url}" alt="">`
        : (p.caption ? `<p class="posttext">${escHtml(p.caption)}</p>` : "")}
      <div class="postact">
        <button class="likebtn ${p.liked ? "on" : ""}" onclick="toggleLike('${p.id}')">
          ${p.liked ? "♥" : "♡"} <span>${p.likes || 0}</span>
        </button>
        ${isReco ? `<button class="solink" onclick="openReport('story','${p.id}','この投稿')">通報</button>` : ""}
      </div>
      ${p.url && p.caption ? `<p class="postcap"><b>${escHtml(p.author.display_name)}</b> ${escHtml(p.caption)}</p>` : ""}
    </article>`;
}

/* ---------- ストーリー閲覧（全画面・自動送り） ---------- */
let STORY_GROUP = [];
function openStoryGroup(gi) {
  const byAuthor = [];
  STORIES.forEach(s => {
    let g = byAuthor.find(g => g.id === s.author_id);
    if (!g) { g = { id: s.author_id, author: s.author, items: [] }; byAuthor.push(g) }
    g.items.push(s);
  });
  const g = byAuthor.sort((a, b) => (a.id === ME.id ? -1 : b.id === ME.id ? 1 : 0))[gi];
  if (!g) return;
  STORY_GROUP = g.items; STORY_IX = 0;
  elx("storyView").classList.add("on");
  paintStory();
}

function paintStory() {
  const s = STORY_GROUP[STORY_IX];
  if (!s) { stopStory(); return }
  const mine = s.author_id === ME.id;
  elx("storyView").innerHTML = `
    <div class="stbars">${STORY_GROUP.map((_, i) =>
      `<i class="${i < STORY_IX ? "done" : i === STORY_IX ? "cur" : ""}"></i>`).join("")}</div>
    <div class="sthd">
      <div><b>${escHtml(s.author.display_name)}</b><span>${leftTime(s.expires_at)}</span></div>
      <button onclick="stopStory()">✕</button>
    </div>
    <div class="stbody">
      <button class="stnav prev" onclick="stepStory(-1)" aria-label="前へ"></button>
      <button class="stnav next" onclick="stepStory(1)" aria-label="次へ"></button>
      ${s.url ? `<img src="${s.url}" alt="">` : `<div class="stna"></div>`}
    </div>
    <p class="stcap">${escHtml(s.caption || "")}</p>
    <div class="stacts">
      ${mine
        ? `<button class="solink" onclick="deleteStory('${s.id}','${s.image_path}')">削除する</button>`
        : `<button class="solink" onclick="openReport('story','${s.id}','この投稿')">通報</button>
           <button class="solink" onclick="blockUser('${s.author_id}')">この人をブロック</button>
           <button class="solink" onclick="dmTo('${s.author_id}')">メッセージを送る</button>`}
    </div>`;
  if (!mine) sb.from("story_views").upsert({ story_id: s.id, viewer_id: ME.id });
  clearTimeout(STORY_TIMER);
  STORY_TIMER = setTimeout(() => stepStory(1), 6000);
}
function stepStory(d) {
  STORY_IX += d;
  if (STORY_IX < 0) { STORY_IX = 0; return }
  if (STORY_IX >= STORY_GROUP.length) { stopStory(); return }
  paintStory();
}
function stopStory() {
  clearTimeout(STORY_TIMER);
  const v = elx("storyView"); if (v) { v.classList.remove("on"); v.innerHTML = "" }
}

/* ---------- さがす ---------- */
function renderFind() {
  elx("soView").innerHTML = `
    <div class="sopad">
      <input class="authinput" id="soFind" type="text" placeholder="ユーザーIDで探す（例：mizuyuu0602）">
      <button class="btn" onclick="searchUser()">探す</button>
      <div id="soFindOut"></div>
      <h3 class="soh" style="margin-top:28px">おすすめ</h3>
      <div id="soReco">${skeleton("読み込んでいます…")}</div>
      <h3 class="soh" style="margin-top:28px">フォロー中</h3>
      <div id="soList"></div>
    </div>`;
  loadFollowing().then(paintFollowing);
  loadSuggested();
}

/* 同じ大会を目指している人を優先して出す（インスタの「おすすめ」に相当） */
async function loadSuggested() {
  const box = elx("soReco");
  if (!box) return;
  try {
    await loadFollowing();
    const exclude = [ME.id, ...FOLLOWING.map(f => f.id)];
    const { data } = await sb.from("profiles")
      .select("id,handle,display_name,sex,avatar_path")
      .limit(30);
    const rows = (data || []).filter(p => !exclude.includes(p.id)).slice(0, 10);
    if (!rows.length) {
      box.innerHTML = `<p class="somsg">まだ他の利用者がいません。投稿すると、あとから来た人のおすすめに出ます。</p>`;
      return;
    }
    box.innerHTML = rows.map(p => `
      <div class="urow">
        <span class="uav">${avatarImg(p, 40)}</span>
        <div class="uinfo"><b>${escHtml(p.display_name || "利用者")}</b><span>@${escHtml(p.handle || "")}</span></div>
        <button class="sobtn sm" onclick="follow('${p.id}');this.textContent='フォロー中';this.disabled=true">フォロー</button>
      </div>`).join("");
  } catch (e) {
    console.error("loadSuggested failed", e);
    box.innerHTML = `<p class="somsg">おすすめを読み込めませんでした。</p>`;
  }
}

async function loadFollowing() {
  const { data } = await sb.from("follows").select("followee_id").eq("follower_id", ME.id);
  const ids = (data || []).map(r => r.followee_id);
  if (!ids.length) { FOLLOWING = []; return }
  const { data: profs } = await sb.from("profiles").select("id,handle,display_name,sex,avatar_path").in("id", ids);
  FOLLOWING = profs || [];
}

async function searchUser() {
  const q = (elx("soFind").value || "").trim().toLowerCase().replace(/^@/, "");
  const out = elx("soFindOut");
  if (!/^[a-z0-9_]{3,20}$/.test(q)) { out.innerHTML = `<p class="somsg err">ユーザーIDを入力してください</p>`; return }
  out.innerHTML = skeleton("探しています…");
  const { data } = await sb.from("profiles").select("id,handle,display_name,avatar_path").eq("handle", q).maybeSingle();
  if (!data) { out.innerHTML = `<p class="somsg">@${escHtml(q)} は見つかりませんでした</p>`; return }
  if (data.id === ME.id) { out.innerHTML = `<p class="somsg">それはあなた自身です</p>`; return }
  const already = FOLLOWING.some(f => f.id === data.id);
  out.innerHTML = `
    <div class="sorow">
      <div><b>${escHtml(data.display_name)}</b><span>@${escHtml(data.handle)}</span></div>
      ${already ? `<span class="sotag">フォロー中</span>`
                : `<button class="sobtn" onclick="follow('${data.id}')">フォローする</button>`}
    </div>`;
}

async function follow(id) {
  const { error } = await sb.from("follows").insert({ follower_id: ME.id, followee_id: id });
  if (error) { alert("フォローできませんでした：" + error.message); return }
  if (typeof track === "function") track("follow", { from: TAB });
  if (TAB === "home") loadHome(); else renderFind();
}
async function unfollow(id) {
  if (!confirm("フォローを外しますか。相手の投稿は見えなくなります。")) return;
  await sb.from("follows").delete().eq("follower_id", ME.id).eq("followee_id", id);
  renderFind();
}

function paintFollowing() {
  const box = elx("soList"); if (!box) return;
  if (!FOLLOWING.length) { box.innerHTML = `<p class="somsg">まだ誰もフォローしていません。</p>`; return }
  box.innerHTML = FOLLOWING.map(f => `
    <div class="sorow">
      <div><b>${escHtml(f.display_name)}</b><span>@${escHtml(f.handle)}</span></div>
      <div class="soacts">
        <button class="sobtn" onclick="pairWith('${f.id}')">ペアで計算</button>
        <button class="solink" onclick="dmTo('${f.id}')">メッセージ</button>
        <button class="solink" onclick="unfollow('${f.id}')">解除</button>
        <button class="solink" onclick="openReport('user','${f.id}','${escAttr(f.display_name)}')">通報</button>
        <button class="solink" onclick="blockUser('${f.id}')">ブロック</button>
      </div>
    </div>`).join("");
}

async function pairWith(userId) {
  if (!R) { alert("先にあなたの診断を終えてください"); return }
  const { data: pub } = await sb.from("athlete_public").select("*").eq("user_id", userId).maybeSingle();
  if (!pub) { alert("相手がまだ診断を終えていません"); return }
  const prof = FOLLOWING.find(f => f.id === userId);
  PARTNER = {
    sex: prof && prof.sex ? prof.sex : (A ? A.sex : "m"),
    lap: pub.lap_sec, S: pub.stations, need: pub.need_weeks,
    name: prof ? prof.display_name : "相手"
  };
  Store.set("partner", PARTNER);
  if (typeof track === "function") track("pair_from_follow");
  closeSocial(); renderDoubles();
  const t = elx("rPair"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- 投稿 ---------- */
function openCompose() {
  show("s-social");
  document.querySelectorAll(".tabbtn").forEach(b => b.classList.remove("on"));
  renderCompose();
}

/* 写真は既定の流れ。無い状態を「まだ選んでいない」として見せる */
function setComposeMode(m) {
  CP_MODE = m;
  closeSourceSheet();
  if (m === "photo" && !SHOT) { pickPhoto(); setTimeout(renderCompose, 600); return }
  renderCompose();
}

function openSourceSheet() {
  closeSourceSheet();
  // .screen に transform が掛かっており position:fixed の基準がその要素になるため、
  // シートは body 直下に出す。
  const el = document.createElement("div");
  el.className = "cpsheet";
  el.id = "cpSheet";
  el.innerHTML = `
    <div class="cpsheetbg" onclick="closeSourceSheet()"></div>
    <div class="cpsheetbox">
      <b>投稿の中身</b>
      <button onclick="setComposeMode('card')" ${R ? "" : "disabled"}>診断結果のカード${R ? "" : "（診断が必要）"}</button>
      <button onclick="setComposeMode('photo')">写真を選ぶ</button>
      <button onclick="setComposeMode('text')">テキストだけ</button>
      <button class="cpsheetcancel" onclick="closeSourceSheet()">キャンセル</button>
    </div>`;
  document.body.appendChild(el);
}
function closeSourceSheet() {
  const el = document.getElementById("cpSheet");
  if (el) el.remove();
}

/* 投稿画面：インスタの共有画面と同じ並び
   （上部バー／サムネイル＋キャプションの1行／ストーリーズにもシェアのトグル） */
function renderCompose() {
  const gear = elx("soGear"); if (gear) gear.hidden = true;
  if (!R && CP_MODE === "card") CP_MODE = "text";
  const cap = elx("cpCap") ? elx("cpCap").value : "";

  const thumb = CP_MODE === "photo" && SHOT
    ? `<img src="${SHOT.src}" alt="">`
    : CP_MODE === "text"
      ? `<span class="cpthumbt">T</span>`
      : `<span class="cpthumbt">◎</span>`;

  elx("soView").innerHTML = `
    <div class="cpbar">
      <button class="cpcancel" onclick="goTab('home')">←</button>
      <b>新規投稿</b>
      <button class="cpshare" id="cpPost" onclick="publish('post')">シェア</button>
    </div>

    <div class="cprow1">
      <button class="cpthumb" onclick="openSourceSheet()">${thumb}<em>変更</em></button>
      <textarea class="cpcap" id="cpCap" rows="4" maxlength="300"
        placeholder="キャプションを入力…">${escHtml(cap)}</textarea>
    </div>

    <label class="cpopt">
      <span>ストーリーズにもシェア</span>
      <input type="checkbox" id="cpStoryToo" ${CP_MODE === "text" ? "disabled" : ""}>
      <i class="sw"></i>
    </label>
    ${CP_MODE === "text" ? `<p class="cpnote">テキストだけの投稿はストーリーズに出せません。</p>` : ""}

  `;
}

async function publish(kind) {
  const cap = (elx("cpCap") ? elx("cpCap").value : "").trim();
  const btn = elx("cpPost");
  const textOnly = CP_MODE === "text";
  const alsoStory = elx("cpStoryToo") ? elx("cpStoryToo").checked : false;
  if (textOnly && !cap) { alert("本文を入力してください"); return }
  if (btn) { btn.disabled = true; btn.textContent = "投稿中…" }
  try {
    const id = crypto.randomUUID();
    let path = null;
    if (!textOnly) {
      const canvas = await buildShareCard(null);
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      path = `${ME.id}/${id}.png`;
      const { error: upErr } = await sb.storage.from(STORY_BUCKET)
        .upload(path, blob, { contentType: "image/png", upsert: false });
      if (upErr) throw upErr;
    }
    const caption = cap || (R ? `予測 ${hms(R.total)} ／ 必要 ${R.need}週` : "");
    const { error } = await sb.from("posts").insert({
      id, author_id: ME.id, image_path: path, kind: "training", caption,
      visibility: "public",
      race: (typeof A === "object" && A && A.race) ? A.race : null
    });
    if (error) throw error;

    if (alsoStory && path) {
      await sb.from("stories").insert({
        id: crypto.randomUUID(), author_id: ME.id, image_path: path, kind: "result", caption
      });
    }
    if (typeof track === "function") track("feed_post", { mode: CP_MODE, story: alsoStory });
    goTab("home");
  } catch (e) {
    alert("投稿できませんでした：" + (e.message || e));
    if (btn) { btn.disabled = false; btn.textContent = "シェア" }
  }
}

/* トレーニング記録をフィードに投稿する（画像は結果カードではなく実施内容） */
async function publishTraining(blob, text, dayIndex) {
  try {
    const id = crypto.randomUUID();
    const path = `${ME.id}/${id}.png`;
    const { error: upErr } = await sb.storage.from(STORY_BUCKET)
      .upload(path, blob, { contentType: "image/png", upsert: false });
    if (upErr) throw upErr;
    const caption = (text || "").split("\n").slice(0, 4).join("\n");
    const { error } = await sb.from("posts").insert({
      id, author_id: ME.id, image_path: path, kind: "training", caption,
      visibility: "public",
      race: (typeof A === "object" && A && A.race) ? A.race : null
    });
    if (error) throw error;
    if (typeof track === "function") track("training_post", { day: (dayIndex ?? 0) + 1 });
    goTab("home");
  } catch (e) {
    alert("投稿できませんでした：" + (e.message || e));
  }
}

async function toggleLike(postId) {
  const p = POSTS.find(x => x.id === postId) || RECO.find(x => x.id === postId);
  if (!p) return;
  if (p.liked) { await sb.from("post_likes").delete().eq("post_id", postId).eq("user_id", ME.id); p.likes--; p.liked = false }
  else { await sb.from("post_likes").insert({ post_id: postId, user_id: ME.id }); p.likes++; p.liked = true }
  renderHome();
}

function postMenu(postId, authorId) {
  if (authorId === ME.id) {
    if (confirm("この投稿を削除しますか。")) deletePost(postId);
    return;
  }
  openReport("story", postId, "この投稿");
}
async function deletePost(id) {
  await sb.from("posts").delete().eq("id", id);
  loadHome();
}
async function deleteStory(id, path) {
  if (!confirm("この投稿を削除しますか。")) return;
  await sb.from("stories").delete().eq("id", id);
  if (path) await sb.storage.from(STORY_BUCKET).remove([path]);
  stopStory(); loadHome();
}

/* ---------- DM ---------- */
async function loadThreads() {
  const { data: parts } = await sb.from("dm_participants").select("thread_id,accepted,last_read_at").eq("user_id", ME.id);
  const ids = (parts || []).map(p => p.thread_id);
  if (!ids.length) { THREADS = []; renderThreads(); return }

  const { data: others } = await sb.from("dm_participants").select("thread_id,user_id").in("thread_id", ids);
  const { data: msgs } = await sb.from("messages").select("thread_id,body,created_at,sender_id")
    .in("thread_id", ids).order("created_at", { ascending: false });

  const who = await profilesByIds([...new Set((others || []).map(o => o.user_id).filter(u => u !== ME.id))]);
  THREADS = (parts || []).map(p => {
    const other = (others || []).find(o => o.thread_id === p.thread_id && o.user_id !== ME.id);
    const last = (msgs || []).find(m => m.thread_id === p.thread_id);
    return {
      id: p.thread_id, accepted: p.accepted,
      other: other ? (who[other.user_id] || { display_name: "利用者" }) : { display_name: "利用者" },
      otherId: other ? other.user_id : null,
      last: last ? last.body : "", at: last ? last.created_at : null
    };
  }).sort((a, b) => (Date.parse(b.at || 0) - Date.parse(a.at || 0)));
  renderThreads();
}

function renderThreads() {
  markAllRead(true);
  const open = THREADS.filter(t => t.accepted);
  const req = THREADS.filter(t => !t.accepted);
  const row = t => `
    <button class="dmrow" onclick="openThread('${t.id}')">
      <div><b>${escHtml(t.other.display_name)}</b><span>${escHtml((t.last || "").slice(0, 40)) || "（メッセージなし）"}</span></div>
      <em>${t.at ? ago(t.at) : ""}</em>
    </button>`;
  elx("soView").innerHTML = `
    <div class="sopad">
      <h3 class="soh">メッセージ</h3>
      ${open.length ? open.map(row).join("") : `<p class="somsg">やり取りはまだありません。</p>`}
      ${req.length ? `<h3 class="soh" style="margin-top:28px">リクエスト <span class="reqn">${req.length}</span></h3>
        <p class="somsg">承認するまで相手に既読は伝わりません。</p>${req.map(row).join("")}` : ""}
    </div>`;
}

async function dmTo(userId) {
  const { data, error } = await sb.rpc("start_dm", { target_user: userId });
  if (error) { alert("メッセージを開始できませんでした：" + error.message); return }
  stopStory(); goTab("dm");
  setTimeout(() => openThread(data), 300);
}

async function openThread(id) {
  OPEN_THREAD = THREADS.find(t => t.id === id) || { id, other: { display_name: "" }, accepted: true };
  const { data: msgs } = await sb.from("messages").select("*").eq("thread_id", id).order("created_at");
  const mine = THREADS.find(t => t.id === id);
  elx("soView").innerHTML = `
    <div class="dmhd">
      <button class="solink" onclick="goTab('dm')">← 戻る</button>
      <b>${escHtml(OPEN_THREAD.other.display_name)}</b>
      <button class="solink" onclick="openReport('user','${OPEN_THREAD.otherId}','${escAttr(OPEN_THREAD.other.display_name)}')">通報</button>
    </div>
    ${mine && !mine.accepted ? `<div class="dmreq">
        <p>この人からのメッセージリクエストです。</p>
        <button class="sobtn" onclick="acceptThread('${id}')">承認する</button>
        <button class="solink" onclick="blockUser('${OPEN_THREAD.otherId}')">ブロック</button>
      </div>` : ""}
    <div class="dmbody" id="dmBody">
      ${(msgs || []).map(m => `<div class="bub ${m.sender_id === ME.id ? "me" : ""}">${escHtml(m.body)}</div>`).join("")
        || `<p class="somsg">まだメッセージがありません。</p>`}
    </div>
    <div class="dmform">
      <input class="authinput" id="dmText" maxlength="2000" placeholder="メッセージ">
      <button class="sobtn" onclick="sendMsg('${id}')">送信</button>
    </div>`;
  const b = elx("dmBody"); if (b) b.scrollTop = b.scrollHeight;
  await sb.from("dm_participants").update({ last_read_at: new Date().toISOString() })
    .eq("thread_id", id).eq("user_id", ME.id);
}

async function acceptThread(id) {
  await sb.from("dm_participants").update({ accepted: true }).eq("thread_id", id).eq("user_id", ME.id);
  await loadThreads(); openThread(id);
}

async function sendMsg(id) {
  const box = elx("dmText"); const body = (box.value || "").trim();
  if (!body) return;
  box.value = "";
  const { error } = await sb.from("messages").insert({ thread_id: id, sender_id: ME.id, body });
  if (error) { alert("送信できませんでした：" + error.message); return }
  if (typeof track === "function") track("dm_send");
  openThread(id);
}

/* ---------- 自分 ---------- */
async function renderMe() {
  const gear=elx("soGear"); if(gear) gear.hidden=false;
  elx("soView").innerHTML = `<div class="sopad"><p class="somsg">読み込んでいます…</p></div>`;
  let myPosts = [], followers = 0, following = 0;
  try {
    const [{ data: ps }, { count: fr }, { count: fg }] = await Promise.all([
      sb.from("posts").select(POST_COLS).eq("author_id", ME.id).order("created_at", { ascending: false }).limit(60),
      sb.from("follows").select("*", { count: "exact", head: true }).eq("followee_id", ME.id),
      sb.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", ME.id),
    ]);
    myPosts = ps || []; followers = fr || 0; following = fg || 0;
    MY_POSTS = myPosts;
    await Promise.all(myPosts.map(async x => { if (x.image_path) x.url = await signed(x.image_path) }));
  } catch (e) { console.error("renderMe failed", e) }

  // 自己紹介：本人が書いたものがあればそれを出す（Instagram と同じ）。
  // 無ければ診断結果から作る（目標レースと予測タイム）
  const bio = [];
  if (MY_PROFILE.bio) bio.push(...String(MY_PROFILE.bio).split("\n").slice(0, 4));
  else if (typeof R === "object" && R && typeof A === "object" && A) {
    const race = (typeof RACES === "object" && RACES[A.race]) ? RACES[A.race] : null;
    if (race && race.date) bio.push(`${race.label}　${race.date.replace(/-/g, ".")}`);
    if (R.total) bio.push(`予測 ${hms(R.total)}／必要な準備 ${R.need}週`);
    if (typeof histStats === "function") {
      const st = histStats();
      if (st.sessions) {
        const h = Math.round(st.minutes / 60 * 10) / 10;
        bio.push(`実施 ${st.sessions}回・${h}時間${st.streak > 1 ? `／連続${st.streak}週` : ""}`);
      }
    }
  }

  const grid = myPosts.length
    ? `<div class="megrid">${myPosts.map(p => `
        <button class="megcell" onclick="openPost('${p.id}')">
          ${p.url ? `<img src="${p.url}" alt="">` : `<span class="megtext">${escHtml((p.caption || "").slice(0, 80))}</span>`}
        </button>`).join("")}</div>`
    : `<div class="meempty">
         <div class="meemptyicon">▦</div>
         <p class="meemptylead">投稿はまだありません</p>
         <p class="meemptysub">トレーニングの記録を残すと、ここに並びます。</p>
         <button class="melink" onclick="openCompose()">最初の投稿をする</button>
       </div>`;

  elx("soView").innerHTML = `
    <div class="mewrap">
      <div class="mehead">
        <button class="meavatar" onclick="pickAvatar()">${avatarImg(MY_PROFILE, 86)}</button>
        <div class="mestats">
          <div><b>${myPosts.length}</b><span>投稿</span></div>
          <div><b>${followers}</b><span>フォロワー</span></div>
          <div><b>${following}</b><span>フォロー中</span></div>
        </div>
      </div>
      <div class="mebio">
        <b>${escHtml(MY_PROFILE.display_name)}</b>
        ${bio.map(l => `<span>${escHtml(l)}</span>`).join("")}
      </div>
      <div class="meacts">
        <button class="meact" onclick="pickAvatar()">プロフィールを編集</button>
        <button class="meact" onclick="shareProfile()">シェア</button>
      </div>
      <div class="metabs"><button class="metab on">▦</button></div>
      ${grid}
    </div>`;
}

/* プロフィールのリンクを共有する */
async function shareProfile() {
  const url = (typeof SITE_URL === "string" ? SITE_URL : location.href);
  const text = `ROXX で HYROX の完走プログラムを作っています。\n@${MY_PROFILE.handle}\n${url}`;
  if (navigator.share) { try { await navigator.share({ text }); return } catch (e) { if (e && e.name === "AbortError") return } }
  try { await navigator.clipboard?.writeText(text); alert("コピーしました") } catch (e) { prompt("このリンクを共有してください", url) }
}

/* 設定（インスタと同じく右上から開く） */
function renderSettings() {
  elx("soView").innerHTML = `
    <div class="sopad">
      <button class="ghost sm" onclick="renderMe()">← 自分のページへ</button>
      ${typeof canOfferInstall === "function" && canOfferInstall()
        ? `<button class="ghost" style="margin-top:16px" onclick="showInstallSheet('menu')">ホーム画面に追加する</button>` : ""}
      <h3 class="soh" style="margin-top:20px">通知</h3>
      <div id="pushState"></div>
      <h3 class="soh" style="margin-top:24px">設定</h3>
      <button class="ghost" onclick="goTab('program')">診断とトレーニングを見る</button>
      <button class="ghost" style="margin-top:9px" onclick="openBlocked()">ブロックした人</button>
      <button class="ghost" style="margin-top:9px" onclick="signOut();leaveShell()">ログアウト</button>
      <h3 class="soh" style="margin-top:24px">安全のために</h3>
      <p class="somsg">不快な投稿やメッセージは通報してください。内容を確認し、削除やアカウント停止を行います。</p>
      <p class="somsg"><a href="./legal/privacy.html">プライバシーポリシー</a>　<a href="./legal/terms.html">利用規約</a></p>
    </div>`;
  if (typeof paintPushState === "function") paintPushState();
}

/* プロフィールのグリッドから1件を開く */
function openPost(id) {
  const p = MY_POSTS.find(x => String(x.id) === String(id));
  if (!p) return;
  elx("soView").innerHTML = `
    <div class="sopad">
      <button class="ghost" style="margin-bottom:12px" onclick="renderMe()">← 自分のページへ</button>
    </div>
    ${postCard(p, false)}`;
}

async function openBlocked() {
  const { data } = await sb.from("blocks").select("blocked_id").eq("blocker_id", ME.id);
  const ids = (data || []).map(b => b.blocked_id);
  const who = await profilesByIds(ids);
  elx("soView").innerHTML = `
    <div class="sopad">
      <div class="dmhd"><button class="solink" onclick="goTab('me')">← 戻る</button><b>ブロックした人</b><span></span></div>
      ${ids.length ? ids.map(id => `
        <div class="sorow">
          <div><b>${escHtml((who[id] || {}).display_name || "利用者")}</b></div>
          <div class="soacts"><button class="sobtn" onclick="unblock('${id}')">解除する</button></div>
        </div>`).join("") : `<p class="somsg">ブロックしている人はいません。</p>`}
    </div>`;
}
async function unblock(id) {
  await sb.from("blocks").delete().eq("blocker_id", ME.id).eq("blocked_id", id);
  openBlocked();
}

/* ---------- 通報・ブロック ---------- */
function openReport(type, id, label) {
  const v = elx("storyView");
  v.innerHTML = `
    <div class="sthd"><div><b>通報する</b><span>${escHtml(label)}</span></div>
      <button onclick="stopStory()">✕</button></div>
    <div class="sopad">
      <p class="somsg">内容を確認し、必要に応じて削除やアカウントの停止を行います。通報したことは相手に通知されません。</p>
      <select class="authinput" id="rpReason">
        <option value="harassment">嫌がらせ・迷惑行為</option>
        <option value="sexual">性的な内容</option>
        <option value="spam">スパム・宣伝</option>
        <option value="impersonation">なりすまし</option>
        <option value="other">その他</option>
      </select>
      <textarea class="authinput" id="rpNote" rows="3" maxlength="500" placeholder="補足があれば（任意）"></textarea>
      <button class="btn" onclick="sendReport('${type}','${id}')">通報する</button>
      <p class="somsg" id="rpMsg"></p>
    </div>`;
  v.classList.add("on");
}

async function sendReport(type, id) {
  const { error } = await sb.from("reports").insert({
    reporter_id: ME.id, target_type: type, target_id: id,
    reason: elx("rpReason").value, note: (elx("rpNote").value || "").trim() || null
  });
  const msg = elx("rpMsg");
  msg.textContent = error ? "送信できませんでした：" + error.message : "通報を受け付けました。確認のうえ対応します。";
  msg.className = "somsg" + (error ? " err" : "");
  if (!error && typeof track === "function") track("report", { type });
}

async function blockUser(id) {
  if (!confirm("この人をブロックしますか。お互いの投稿とプロフィールが見えなくなり、メッセージも届かなくなります。")) return;
  await sb.from("blocks").insert({ blocker_id: ME.id, blocked_id: id });
  await sb.from("follows").delete().eq("follower_id", ME.id).eq("followee_id", id);
  if (typeof track === "function") track("block");
  stopStory(); goTab("home");
}

/* ---------- 共通 ---------- */
async function profilesByIds(ids) {
  const map = {};
  if (!ids || !ids.length) return map;
  const { data } = await sb.from("profiles").select("id,handle,display_name,avatar_path").in("id", ids);
  (data || []).forEach(p => { map[p.id] = p });
  return map;
}
async function signed(path) {
  const { data } = await sb.storage.from(STORY_BUCKET).createSignedUrl(path, 3600);
  return data ? data.signedUrl : null;
}
function leftTime(exp) {
  const m = Math.max(0, Math.round((Date.parse(exp) - Date.now()) / 60000));
  return m >= 60 ? `あと${Math.floor(m / 60)}時間` : `あと${m}分`;
}
function ago(at) {
  const m = Math.round((Date.now() - Date.parse(at)) / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escAttr(s) { return escHtml(s).replace(/'/g, "&#39;") }
