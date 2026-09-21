/* ============================================================
   ROXX / 認証とサーバー同期

   方針
    * 診断エンジン（compute / runGen / 週の再調整）には一切触らない。
      このファイルは index.html のグローバルを読むだけで、上書きしない。
    * アカウントは任意。作らなくても今まで通り端末内で完結する。
    * 体格情報は athlete_state にしか書かない。他人に見える athlete_public
      には算出後の秒数だけを入れる。
   ============================================================ */

const SB_URL = "https://yywygivoktufvgcyswji.supabase.co";
const SB_KEY = "sb_publishable_4weyT_yG1leYCU1tJ69U_g_5M5q5t8r";

let sb = null;
let ME = null;        // auth.users の行
let MY_PROFILE = null;

const $$ = id => document.getElementById(id);

/* ---------- 起動 ---------- */
function authBoot() {
  if (!window.supabase || !window.supabase.createClient) {
    // ライブラリが読めなくてもアプリ本体は動かす
    paintAccount();
    return;
  }
  sb = window.supabase.createClient(SB_URL, SB_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  sb.auth.onAuthStateChange((_evt, session) => {
    ME = session ? session.user : null;
    if (ME) afterSignIn(); else { MY_PROFILE = null; paintAccount() }
  });

  sb.auth.getSession().then(({ data }) => {
    ME = data && data.session ? data.session.user : null;
    if (ME) afterSignIn(); else paintAccount();
  });
}

/* ---------- サインイン ---------- */
let AUTH_MODE = "signin";
const TERMS_VERSION = "2026-08-29";     // legal/terms.html の日付
const PRIVACY_VERSION = "2026-09-09";   // legal/privacy.html の最終更新

function togglePassword() {
  const el = $$("authPass"), eye = $$("pwEye");
  if (!el) return;
  const show = el.type === "password";
  el.type = show ? "text" : "password";
  if (eye) { eye.textContent = show ? "隠す" : "表示"; eye.setAttribute("aria-label", show ? "パスワードを隠す" : "パスワードを表示") }
}
function setAuthMode(m) { AUTH_MODE = m; paintAccount() }

function readCreds() {
  const email = ($$("authEmail") ? $$("authEmail").value : "").trim();
  const password = $$("authPass") ? $$("authPass").value : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { authMsg("メールアドレスの形式を確認してください", true); return null }
  if (password.length < 8) { authMsg("パスワードは8文字以上にしてください", true); return null }
  return { email, password };
}

/* メールとパスワードでログイン */
async function signInWithPassword() {
  const c = readCreds(); if (!c) return;
  authMsg("確認しています…");
  const { error } = await sb.auth.signInWithPassword(c);
  if (error) {
    const m = /Email not confirmed/i.test(error.message)
      ? "メールの確認がまだです。登録時に届いたメールのリンクを押してください。"
      : /Invalid login credentials/i.test(error.message)
        ? "メールアドレスかパスワードが違います。"
        : error.message;
    authMsg(m, true); return;
  }
  authMsg("");
  if (typeof track === "function") track("signin_password");
  if (typeof goTab === "function") setTimeout(() => goTab("home"), 300);
  if (typeof maybeOfferInstall === "function") maybeOfferInstall("signin");
}

/* 新規登録。このプロジェクトは確認メールが必須の設定になっている */
async function signUpWithPassword() {
  const c = readCreds(); if (!c) return;
  if (!($$("authAgree") && $$("authAgree").checked)) {
    authMsg("利用規約とプライバシーポリシーへの同意が必要です", true); return;
  }
  authMsg("登録しています…");
  const redirect = location.origin + location.pathname;
  const { data, error } = await sb.auth.signUp({ email: c.email, password: c.password, options: {
    emailRedirectTo: redirect,
    data: { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, agreed_at: new Date().toISOString() }
  } });
  if (error) {
    const m = /already registered/i.test(error.message)
      ? "このメールアドレスは登録済みです。ログインに切り替えてください。"
      : error.message;
    authMsg(m, true); return;
  }
  if (data && data.session) { authMsg(""); return }
  authMsg(c.email + " に確認メールを送りました。リンクを押すとログインできます。");
  if (typeof track === "function") track("signup_password");
}

/* パスワードの再設定メールを送る */
async function resetPassword() {
  const email = ($$("authEmail") ? $$("authEmail").value : "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { authMsg("先にメールアドレスを入力してください", true); return }
  authMsg("送信しています…");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) { authMsg("送信できませんでした：" + error.message, true); return }
  authMsg(email + " に再設定用のメールを送りました。");
}

async function sendMagicLink() {
  const el = $$("authEmail");
  const email = (el ? el.value : "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    authMsg("メールアドレスの形式を確認してください", true);
    return;
  }
  authMsg("送信しています…");
  const redirect = location.origin + location.pathname;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect }
  });
  if (error) { authMsg("送信できませんでした：" + error.message, true); return }
  authMsg(email + " にログイン用のリンクを送りました。メールを開いてリンクを押してください。");
  if (typeof track === "function") track("signin_requested");
}

async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  ME = null; MY_PROFILE = null;
  paintAccount();
}

function authMsg(t, isErr) {
  const el = $$("authMsg");
  if (!el) return;
  el.textContent = t;
  el.className = "authmsg" + (isErr ? " err" : "");
}

/* ---------- サインイン後 ---------- */
async function afterSignIn() {
  // URLに残るトークンの断片を消す
  if (location.hash.indexOf("access_token") >= 0) {
    history.replaceState({}, "", location.pathname);
  }
  await loadProfile();
  if (!MY_PROFILE) { paintAccount(); return }   // プロフィール未作成
  await syncState();
  paintAccount();
  if (typeof enterShell === "function") enterShell();
  if (typeof track === "function") track("signed_in");
}

async function loadProfile() {
  const { data, error } = await sb.from("profiles").select("*").eq("id", ME.id).maybeSingle();
  MY_PROFILE = error ? null : data;
}

function suggestHandle() {
  const base = (ME && ME.email ? ME.email.split("@")[0] : "roxx")
    .toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  return base.length >= 3 ? base : (base + "_roxx").slice(0, 20);
}

async function createProfile() {
  const h = ($$("pfHandle").value || "").trim().toLowerCase();
  const n = ($$("pfName").value || "").trim();
  if (!/^[a-z0-9_]{3,20}$/.test(h)) {
    authMsg("ユーザーIDは半角英小文字・数字・アンダースコアで3〜20文字です", true); return;
  }
  if (n.length < 1 || n.length > 30) { authMsg("表示名は1〜30文字で入力してください", true); return }

  authMsg("作成しています…");
  const row = { id: ME.id, handle: h, display_name: n };
  if (typeof A === "object" && A && (A.sex === "m" || A.sex === "f")) row.sex = A.sex;

  const { error } = await sb.from("profiles").insert(row);
  if (error) {
    authMsg(error.code === "23505"
      ? "そのユーザーIDは既に使われています"
      : "作成できませんでした：" + error.message, true);
    return;
  }
  await loadProfile();
  await syncState();
  paintAccount();
  if (typeof enterShell === "function") enterShell();
  authMsg("");
}

/* ---------- 端末とサーバーの同期 ----------
   どちらが新しいかで向きを決める。古い方で上書きして記録を消さない。 */
async function syncState() {
  const localAt = Number(Store.get("updated")) || 0;
  const { data: remote } = await sb.from("athlete_state").select("*").eq("user_id", ME.id).maybeSingle();
  const remoteAt = remote ? Date.parse(remote.updated_at) : 0;
  const hasLocal = !!Store.get("answers");

  if (remote && remoteAt >= localAt) { pullDown(remote); return }
  if (hasLocal) { await pushUp() }
}

function pullDown(remote) {
  try {
    Store.set("answers", remote.answers);
    Store.set("result", remote.result);
    Store.set("week", remote.week);
    if (remote.paid === true) Store.set("paid", true);
    Store.set("updated", Date.parse(remote.updated_at));
    if (typeof restore === "function") restore();
  } catch (e) {}
}

async function pushUp() {
  const answers = Store.get("answers");
  const result = Store.get("result");
  if (!answers || !result) return;
  const now = new Date().toISOString();

  await sb.from("athlete_state").upsert({
    user_id: ME.id, answers, result,
    week: Store.get("week") || 1,
    paid: Store.get("paid") === true,
    updated_at: now
  });

  // 他人に見える側。体格情報は入れない
  if (typeof R === "object" && R && R.S && R.lap) {
    const stations = {};
    Object.keys(R.S).forEach(k => { stations[k] = Math.round(R.S[k]) });
    await sb.from("athlete_public").upsert({
      user_id: ME.id,
      lap_sec: Math.round(R.lap),
      stations,
      need_weeks: R.need,
      total_sec: Math.round(R.total),
      race: A && A.race ? A.race : null,
      updated_at: now
    });
  }
  Store.set("updated", Date.now());
}

/* 「入力をやり直す」時のサーバー側。
   athlete_state は消さずに中身だけ空にする。paid をここに持っているため、
   行ごと消すと他端末の課金状態まで失われる。 */
async function resetServerState() {
  if (!sb || !ME || !MY_PROFILE) return;
  try {
    await sb.from("athlete_state").upsert({
      user_id: ME.id, answers: {}, result: {}, week: 1,
      paid: Store.get("paid") === true,
      updated_at: new Date().toISOString()
    });
    await sb.from("athlete_public").delete().eq("user_id", ME.id);
    await sb.from("training_logs").delete().eq("user_id", ME.id);
  } catch (e) {}
}

/* 診断や週締めのあとに呼ぶ。ログインしていなければ何もしない */
async function syncIfSignedIn() {
  Store.set("updated", Date.now());
  if (sb && ME && MY_PROFILE) { try { await pushUp() } catch (e) {} }
}

/* ---------- 表示 ---------- */
function paintAccount() {
  document.body.classList.toggle("signedin", !!(ME && MY_PROFILE));
  const box = $$("acct");
  if (!box) return;

  if (!sb) {
    box.innerHTML = `<p class="authmsg">アカウント機能を読み込めませんでした。診断とトレーニングはこのまま使えます。</p>`;
    return;
  }
  if (!ME) {
    const signup = AUTH_MODE === "signup";
    box.innerHTML = `
      <input class="authinput" id="authEmail" type="email" inputmode="email" autocomplete="email" placeholder="メールアドレス">
      <div class="pwwrap">
        <input class="authinput" id="authPass" type="password" autocomplete="${signup ? "new-password" : "current-password"}" placeholder="パスワード（8文字以上）">
        <button type="button" class="pweye" id="pwEye" aria-label="パスワードを表示" onclick="togglePassword()">表示</button>
      </div>
      ${signup ? `<label class="agree">
        <input type="checkbox" id="authAgree">
        <span><a href="./legal/terms.html" target="_blank" rel="noopener">利用規約</a>と<a href="./legal/privacy.html" target="_blank" rel="noopener">プライバシーポリシー</a>に同意します</span>
      </label>` : ""}
      <button class="loginbtn" onclick="${signup ? "signUpWithPassword()" : "signInWithPassword()"}">${signup ? "登録する" : "ログイン"}</button>
      <p class="authmsg" id="authMsg"></p>
      ${signup
        ? `<p class="loginnote">登録すると確認メールが届きます。リンクを押すと使えるようになります。</p>
           <button class="loginsub" onclick="setAuthMode('signin')">アカウントをお持ちですか？　ログイン</button>`
        : `<button class="loginsub" onclick="resetPassword()">パスワードを忘れた場合</button>
           <div class="loginsep">または</div>
           <button class="loginalt" onclick="setAuthMode('signup')">新しいアカウントを作成</button>
           <button class="loginsub" onclick="sendMagicLink()">メールのリンクでログイン</button>`}
      <p class="loginnote">身長・体重・年齢は本人しか見られない領域に保存されます。他の利用者には表示されません。</p>`;
    return;
  }
  if (!MY_PROFILE) {
    box.innerHTML = `
      <p class="authlead">はじめまして。表示名とユーザーIDを決めてください。<b>あとから変更できます。</b></p>
      <input class="authinput" id="pfName" type="text" maxlength="30" placeholder="表示名（例：ユウ）">
      <input class="authinput" id="pfHandle" type="text" maxlength="20" placeholder="ユーザーID（半角英数字）" value="${suggestHandle()}">
      <button class="btn" onclick="createProfile()">はじめる</button>
      <p class="authmsg" id="authMsg"></p>
      <button class="redo" onclick="signOut()">別のアカウントでログインする</button>`;
    return;
  }
  box.innerHTML = `
    <div class="acctrow">
      <div><b>${escapeHtml(MY_PROFILE.display_name)}</b><span>@${escapeHtml(MY_PROFILE.handle)}</span></div>
      <button onclick="signOut()">ログアウト</button>
    </div>
    <button class="btn" style="margin-top:12px" onclick="openSocial()">仲間とストーリーを見る</button>
    <p class="authnote">記録はこのアカウントに保存されています。別の端末で同じメールアドレスからログインすると続きから使えます。</p>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

window.addEventListener("DOMContentLoaded", authBoot);
