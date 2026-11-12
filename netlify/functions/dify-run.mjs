import { getStore } from "@netlify/blobs";

// Run long Dify Chatflow requests outside the 30-second interactive response path.
// Netlify acknowledges immediately (HTTP 202); the browser polls dify-result.
export const config = { background: true };

const store = () => getStore({ name: "dify-chat-jobs", consistency: "strong" });

export default async function handler(request) {
  let jobId = "";
  try {
    if (request.method !== "POST") return;
    const body = await request.json();
    jobId = body.job_id || "";
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(jobId) ||
        typeof body.query !== "string" || !body.query.trim() || body.query.length > 4000 ||
        typeof body.user !== "string" || !/^web-[0-9a-f-]{36}$/i.test(body.user)) return;

    const blobs = store();
    await blobs.setJSON(jobId, { status: "running", created_at: Date.now() });

    const apiKey = process.env.DIFY_API_KEY;
    if (!apiKey) throw new Error("Dify API Key 未配置");
    const apiBase = (process.env.DIFY_API_BASE || "https://api.dify.ai/v1").replace(/\/$/, "");
    const upstream = await fetch(apiBase + "/chat-messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {},
        query: body.query,
        response_mode: "streaming",
        conversation_id: body.conversation_id || "",
        user: body.user,
        files: [],
      }),
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      throw new Error("Dify API HTTP " + upstream.status + ": " + detail);
    }
    if (!upstream.body) throw new Error("Dify 未返回流式响应");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let answer = "";
    let conversationId = "";
    let messageId = "";
    let resources = [];
    let finished = false;

    function handleLine(line) {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let e;
      try { e = JSON.parse(payload); } catch { return; }
      if (e.conversation_id) conversationId = e.conversation_id;
      if (e.message_id) messageId = e.message_id;
      if ((e.event === "message" || e.event === "agent_message") && typeof e.answer === "string") {
        answer += e.answer;
      } else if (e.event === "workflow_finished") {
        finished = true;
        if (e.data?.status === "failed") throw new Error("Dify 工作流执行失败");
        if (!answer && typeof e.data?.outputs?.answer === "string") answer = e.data.outputs.answer;
        if (!answer && typeof e.data?.outputs?.text === "string") answer = e.data.outputs.text;
      } else if (e.event === "message_end") {
        finished = true;
        if (Array.isArray(e.metadata?.retriever_resources)) resources = e.metadata.retriever_resources;
      } else if (e.event === "error") {
        throw new Error("Dify 工作流错误：" + (e.message || e.code || "未知错误"));
      }
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) handleLine(line);
      }
      pending += decoder.decode();
      if (pending) handleLine(pending);
    } finally {
      reader.releaseLock();
    }

    if (!answer.trim()) throw new Error("Dify 流式响应结束，但未返回回答；请检查工作流是否生成直接回复");
    await blobs.setJSON(jobId, {
      status: "done",
      answer,
      conversation_id: conversationId,
      message_id: messageId,
      retriever_resources: resources,
      completed_at: Date.now(),
    });
    console.log("Dify background job succeeded", jobId, "completed", finished);
  } catch (error) {
    console.error("Dify background job failed", jobId, String(error));
    if (jobId) {
      try {
        await store().setJSON(jobId, { status: "error", error: String(error.message || error).slice(0, 400), completed_at: Date.now() });
      } catch (writeError) {
        console.error("Dify job status write failed", String(writeError));
      }
    }
  }
}
