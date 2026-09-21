// ROXX / stripe-webhook
// Stripe の支払い通知を受けて、public.entitlements（課金状態）を更新する。
// 課金状態を書けるのはこの関数だけ（service_role）。アプリ側からは読むことしかできない。
//
// 通知は署名を検証してから処理する。署名が合わないものは何も書かずに 400 を返す。
// 購入時にアプリが渡した client_reference_id（= Supabase のユーザーID）で利用者を特定する。
import Stripe from "npm:stripe@16.12.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Secrets に貼る際に末尾の改行が混ざりやすいので取り除く
const stripeKey = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
const webhookSecret = (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "").trim();

const stripe = new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() });
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function periodEnd(sub: Stripe.Subscription): string | null {
  // API の版によって期間終了の位置が異なるため、両方を見る
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const t = (sub as unknown as { current_period_end?: number }).current_period_end ?? item?.current_period_end;
  return t ? new Date(t * 1000).toISOString() : null;
}

async function saveFromSubscription(userId: string, sub: Stripe.Subscription): Promise<void> {
  const { error } = await sb.from("entitlements").upsert({
    user_id: userId,
    status: sub.status,
    current_period_end: periodEnd(sub),
    stripe_customer: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    stripe_subscription: sub.id,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  if (!stripeKey || !webhookSecret) {
    console.error("STRIPE_SECRET_KEY または STRIPE_WEBHOOK_SECRET が未設定");
    return json({ ok: false, error: "not configured" }, 500);
  }

  const signature = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, cryptoProvider);
  } catch (e) {
    console.error("署名の検証に失敗", (e as Error).message);
    return json({ ok: false, error: "bad signature" }, 400);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.client_reference_id ?? "";
      if (!UUID_RE.test(userId)) {
        // ログインせずに購入した場合など。誰の購入か分からないので記録できない
        console.error("client_reference_id が無い購入", { session: s.id });
        return json({ ok: true, skipped: "no user" });
      }
      if (!s.subscription) return json({ ok: true, skipped: "not a subscription" });
      const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      // 以降の更新通知で利用者を引けるよう、サブスクリプション側にもユーザーIDを残す
      await stripe.subscriptions.update(subId, { metadata: { supabase_user_id: userId } });
      await saveFromSubscription(userId, sub);
      return json({ ok: true });
    }

    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.created"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      let userId = sub.metadata?.supabase_user_id ?? "";
      if (!UUID_RE.test(userId)) {
        const { data } = await sb.from("entitlements").select("user_id").eq("stripe_subscription", sub.id).maybeSingle();
        userId = data?.user_id ?? "";
      }
      if (!UUID_RE.test(userId)) return json({ ok: true, skipped: "unknown subscription" });
      await saveFromSubscription(userId, sub);
      return json({ ok: true });
    }

    return json({ ok: true, ignored: event.type });
  } catch (e) {
    console.error("課金状態の保存に失敗", (e as Error).message);
    // 500 を返すと Stripe が時間を置いて再送してくれる
    return json({ ok: false, error: "save failed" }, 500);
  }
});
