// Recover a completed Dify Chatflow answer when a long SSE connection closes early.
// The Dify API key stays on the Netlify server, never in browser JavaScript.
export default async (request) => {
  if (request.method !== "GET") return reply({ error: "Method not allowed" }, 405);

  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) return reply({ error: "Dify API 未配置" }, 503);

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversation_id") || "";
  const user = url.searchParams.get("user") || "";
  const messageId = url.searchParams.get("message_id") || "";
  const query = url.searchParams.get("query") || "";

  if (!conversationId || !user || (!messageId && !query)) {
    return reply({ error: "Missing conversation_id, user, or message identifier" }, 400);
  }

  const apiBase = (process.env.DIFY_API_BASE || "https://api.dify.ai/v1").replace(/\/$/, "");
  const params = new URLSearchParams({ conversation_id: conversationId, user, limit: "20" });

  try {
    const response = await fetch(`${apiBase}/messages?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return reply({ error: "Dify 会话查询失败", status: response.status }, response.status);
    }
    const payload = await response.json();
    const records = Array.isArray(payload.data) ? payload.data : [];
    const found = records.find((item) => messageId && item.id === messageId) ||
      records.find((item) => item.query === query && typeof item.answer === "string" && item.answer.trim());

    if (!found || typeof found.answer !== "string" || !found.answer.trim()) {
      return reply({ ready: false });
    }

    return reply({
      ready: true,
      answer: found.answer,
      conversation_id: conversationId,
      message_id: found.id,
      retriever_resources: found.retriever_resources || [],
    });
  } catch (err) {
    return reply({ error: "查询会话结果失败", detail: String(err) }, 502);
  }
};

function reply(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
