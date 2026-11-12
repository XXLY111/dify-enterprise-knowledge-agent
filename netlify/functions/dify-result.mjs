import { getStore } from "@netlify/blobs";

export default async function handler(request) {
  if (request.method !== "GET") return respond({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  const jobId = url.searchParams.get("job_id") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(jobId)) return respond({ error: "Invalid job_id" }, 400);

  try {
    const blobs = getStore({ name: "dify-chat-jobs", consistency: "strong" });
    const job = await blobs.get(jobId, { type: "json", consistency: "strong" });
    if (!job) return respond({ status: "pending" });
    if (job.completed_at && Date.now() - job.completed_at > 24 * 60 * 60 * 1000) {
      await blobs.delete(jobId);
      return respond({ status: "expired" }, 410);
    }
    return respond(job);
  } catch (e) {
    console.error("Dify result lookup failed", String(e));
    return respond({ status: "error", error: "无法读取任务结果，请检查 Netlify Blobs 是否可用" }, 503);
  }
}

function respond(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
