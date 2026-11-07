import { timingSafeEqual } from "node:crypto";

const ZERNIO_BASE = "https://zernio.com/api/v1";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { message: text.slice(0, 1000) }; }
}

function upstreamError(status, data) {
  if (status === 401) {
    return json({
      code: "ZERNIO_KEY_INVALID",
      message: "A Zernio recusou a chave ZERNIO_API_KEY cadastrada no Netlify. A senha do painel foi aceita.",
      upstreamStatus: status,
      details: data,
    }, 502);
  }
  if (status === 402) {
    return json({
      code: "ZERNIO_ANALYTICS_REQUIRED",
      message: "A Zernio informou que este recurso de Analytics não está disponível para esta conta ou plano.",
      upstreamStatus: status,
      details: data,
    }, 402);
  }
  if (status === 403) {
    return json({
      code: "ZERNIO_PERMISSION_DENIED",
      message: "A Zernio recusou o acesso. Verifique o acesso Analytics e as permissões da conta Instagram conectada.",
      upstreamStatus: status,
      details: data,
    }, 403);
  }
  const message = data?.error || data?.message || `A Zernio respondeu com HTTP ${status}.`;
  return json({ code: "ZERNIO_UPSTREAM_ERROR", message, upstreamStatus: status, details: data }, status >= 500 ? 502 : status);
}

async function zernio(path, init = {}) {
  let response;
  try {
    response = await fetch(`${ZERNIO_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${process.env.ZERNIO_API_KEY || process.env.ZERNIO_KEY || process.env.LATE_API_KEY}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });
  } catch {
    return json({ code: "ZERNIO_NETWORK_ERROR", message: "Não foi possível conectar à Zernio. Tente novamente em instantes." }, 502);
  }
  const data = await readJson(response);
  return response.ok ? json(data, response.status) : upstreamError(response.status, data);
}

function validAccountId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,128}$/.test(value);
}

function makeRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return {
    fromDate: start.toISOString().slice(0, 10),
    toDate: end.toISOString().slice(0, 10),
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const zernioKey = process.env.ZERNIO_API_KEY || process.env.ZERNIO_KEY || process.env.LATE_API_KEY;

  if (!adminPassword) return json({ code: "ADMIN_PASSWORD_MISSING", message: "Falta ADMIN_PASSWORD nas variáveis de ambiente do Netlify." }, 500);
  if (!zernioKey) return json({ code: "ZERNIO_KEY_MISSING", message: "Falta ZERNIO_API_KEY nas variáveis de ambiente do Netlify." }, 500);

  const suppliedPassword = req.headers.get("x-senha") || "";
  if (!sameSecret(suppliedPassword, adminPassword)) {
    return json({ code: "ADMIN_PASSWORD_INVALID", message: "A senha do painel não confere com ADMIN_PASSWORD no Netlify." }, 401);
  }

  try {
    if (path === "/api/zernio/accounts" && req.method === "GET") {
      return await zernio("/accounts?platform=instagram");
    }

    if (path === "/api/zernio/insights" && req.method === "GET") {
      const accountId = url.searchParams.get("accountId") || "";
      const days = Number(url.searchParams.get("days") || 30);
      if (!validAccountId(accountId)) return json({ code: "ACCOUNT_ID_INVALID", message: "Escolha uma conta Instagram válida." }, 400);
      if (![7, 30, 90].includes(days)) return json({ code: "PERIOD_INVALID", message: "O período deve ser 7, 30 ou 90 dias." }, 400);
      const range = makeRange(days);
      const params = new URLSearchParams({
        accountId,
        ...range,
        metrics: "reach,views,accounts_engaged,total_interactions,comments,likes,saves,shares,replies,reposts,follows_and_unfollows,profile_links_taps,profile_views,website_clicks",
        metricType: "total_value",
      });
      return await zernio(`/analytics/instagram/account-insights?${params}`);
    }

    if (path === "/api/zernio/follower-history" && req.method === "GET") {
      const accountId = url.searchParams.get("accountId") || "";
      const days = Number(url.searchParams.get("days") || 30);
      if (!validAccountId(accountId)) return json({ code: "ACCOUNT_ID_INVALID", message: "Escolha uma conta Instagram válida." }, 400);
      if (![7, 30, 90].includes(days)) return json({ code: "PERIOD_INVALID", message: "O período deve ser 7, 30 ou 90 dias." }, 400);
      const range = makeRange(Math.min(days, 89));
      const params = new URLSearchParams({ accountId, ...range, metrics: "follower_count", metricType: "time_series" });
      return await zernio(`/analytics/instagram/follower-history?${params}`);
    }

    if (path === "/api/zernio/demographics" && req.method === "GET") {
      const accountId = url.searchParams.get("accountId") || "";
      if (!validAccountId(accountId)) return json({ code: "ACCOUNT_ID_INVALID", message: "Escolha uma conta Instagram válida." }, 400);
      return await zernio(`/analytics/instagram/demographics?${new URLSearchParams({ accountId })}`);
    }

    if (path === "/api/zernio/posts" && req.method === "GET") {
      const accountId = url.searchParams.get("accountId") || "";
      const days = Number(url.searchParams.get("days") || 30);
      if (!validAccountId(accountId)) return json({ code: "ACCOUNT_ID_INVALID", message: "Escolha uma conta Instagram válida." }, 400);
      if (![7, 30, 90].includes(days)) return json({ code: "PERIOD_INVALID", message: "O período deve ser 7, 30 ou 90 dias." }, 400);
      const params = new URLSearchParams({ platform: "instagram", accountId, ...makeRange(days), limit: "10", sortBy: "engagement", order: "desc" });
      return await zernio(`/analytics?${params}`);
    }

    if (path === "/api/zernio/post" && req.method === "POST") {
      let body;
      try { body = await req.json(); }
      catch { return json({ code: "BODY_INVALID", message: "O corpo da solicitação não é JSON válido." }, 400); }
      const content = typeof body?.content === "string" ? body.content.trim() : "";
      const platform = body?.platform;
      const accountId = body?.accountId;
      if (!content || content.length > 2200 || !platform || !validAccountId(accountId)) {
        return json({ code: "POST_FIELDS_INVALID", message: "Informe texto, plataforma e ID de conta válidos. O texto pode ter até 2.200 caracteres." }, 400);
      }
      const payload = { content, platforms: [{ platform, accountId }] };
      if (body.scheduledFor) payload.scheduledFor = body.scheduledFor;
      else payload.publishNow = true;
      return await zernio("/posts", { method: "POST", body: JSON.stringify(payload) });
    }

    return json({ code: "ROUTE_NOT_FOUND", message: "Esta rota não existe." }, 404);
  } catch (error) {
    return json({ code: "SERVER_ERROR", message: error?.message || "Erro inesperado no servidor." }, 500);
  }
};

export const config = { path: "/api/zernio/*" };
