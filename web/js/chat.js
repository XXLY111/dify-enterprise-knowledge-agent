const API_CHAT = "/.netlify/functions/dify-chat";
const API_CONFIG = "/.netlify/functions/dify-config";

const state = {
  conversationId: "",
  userId: "",
  isStreaming: false,
  mode: "api",
};

const els = {
  messages: document.getElementById("messages"),
  messageInput: document.getElementById("messageInput"),
  composerForm: document.getElementById("composerForm"),
  sendBtn: document.getElementById("sendBtn"),
  chatStatus: document.getElementById("chatStatus"),
  chatAppName: document.getElementById("chatAppName"),
  newChatBtn: document.getElementById("newChatBtn"),
  setupNotice: document.getElementById("setupNotice"),
  chatContainer: document.getElementById("chatContainer"),
  embedContainer: document.getElementById("embedContainer"),
  difyEmbed: document.getElementById("difyEmbed"),
  sampleQuestions: document.getElementById("sampleQuestions"),
};

init();

async function init() {
  state.userId = getOrCreateUserId();
  bindEvents();
  await loadConfig();
  showWelcome();
}

function bindEvents() {
  els.composerForm.addEventListener("submit", onSubmit);
  els.messageInput.addEventListener("keydown", onKeyDown);
  els.messageInput.addEventListener("input", autoResize);
  els.newChatBtn.addEventListener("click", resetConversation);

  els.sampleQuestions?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-q]");
    if (!button || state.mode === "embed") return;
    els.messageInput.value = button.dataset.q;
    autoResize.call(els.messageInput);
    els.messageInput.focus();
  });
}

async function loadConfig() {
  try {
    const response = await fetch(API_CONFIG);
    const config = await response.json();

    if (config.appName) {
      els.chatAppName.textContent = config.appName;
    }

    if (config.mode === "embed" && config.embedUrl) {
      enableEmbedMode(config.embedUrl);
      return;
    }

    if (!config.configured) {
      els.chatStatus.textContent = "等待管理员配置 Dify API";
      els.setupNotice.classList.remove("hidden");
      els.sendBtn.disabled = true;
      return;
    }

    els.chatStatus.textContent = "已连接 · 可开始提问";
    els.sendBtn.disabled = false;
    els.setupNotice.classList.add("hidden");
  } catch {
    els.chatStatus.textContent = "配置加载失败";
    els.setupNotice.classList.remove("hidden");
  }
}

function enableEmbedMode(embedUrl) {
  state.mode = "embed";
  els.chatContainer.classList.add("hidden");
  els.embedContainer.classList.remove("hidden");
  els.embedContainer.setAttribute("aria-hidden", "false");
  els.difyEmbed.src = embedUrl;
  els.chatStatus.textContent = "已加载 Dify 嵌入对话";
  els.newChatBtn.disabled = true;
}

function showWelcome() {
  if (state.mode === "embed") return;
  if (els.messages.querySelector(".welcome")) return;

  els.messages.innerHTML = `
    <div class="welcome">
      <strong>欢迎使用企业内部知识库 Agent</strong>
      你可以询问 SOP 流程、产品规格、成本价目、供应商信息等问题。
      点击左侧示例问题可快速体验，或直接在下方输入。
    </div>
  `;
}

function resetConversation() {
  if (state.isStreaming) return;
  state.conversationId = "";
  els.messages.innerHTML = "";
  showWelcome();
  els.chatStatus.textContent = "已开始新对话";
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.mode === "embed" || state.isStreaming) return;

  const query = els.messageInput.value.trim();
  if (!query) return;

  els.messageInput.value = "";
  autoResize.call(els.messageInput);

  const welcome = els.messages.querySelector(".welcome");
  if (welcome) welcome.remove();

  appendMessage("user", query);
  const botBubble = appendMessage("bot", "", { loading: true });

  state.isStreaming = true;
  els.sendBtn.disabled = true;
  els.chatStatus.textContent = "正在思考…";

  try {
    await streamChat(query, botBubble);
    els.chatStatus.textContent = "已连接 · 可继续提问";
  } catch (error) {
    botBubble.classList.remove("loading");
    botBubble.textContent = error.message || "请求失败，请稍后重试。";
    els.chatStatus.textContent = "请求出错";
  } finally {
    state.isStreaming = false;
    els.sendBtn.disabled = false;
    els.messageInput.focus();
  }
}

async function streamChat(query, bubbleEl) {
  // Dify Chatflows may take more than 30 seconds. Netlify's interactive
  // streaming proxy was terminating before Dify emitted the final answer.
  // Start a background job instead, then fetch its completed result.
  const jobId = crypto.randomUUID();
  const response = await fetch("/.netlify/functions/dify-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      query,
      conversation_id: state.conversationId,
      user: state.userId,
    }),
  });

  if (response.status !== 202) {
    let explanation = "无法创建后台问答任务";
    try {
      const data = await response.json();
      explanation = data.error || data.message || explanation;
    } catch { /* Netlify may return an HTML error page */ }
    throw new Error(explanation + "（HTTP " + response.status + "）");
  }

  bubbleEl.textContent = "正在检索知识库并生成回答…";
  const startedAt = Date.now();
  const timeoutMs = 8 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let resultResponse;
    try {
      resultResponse = await fetch(
        "/.netlify/functions/dify-result?job_id=" + encodeURIComponent(jobId),
        { cache: "no-store" }
      );
    } catch {
      continue; // Retry a transient connectivity problem.
    }

    let result;
    try {
      result = await resultResponse.json();
    } catch {
      if (!resultResponse.ok) throw new Error("任务查询接口返回了无效数据");
      continue;
    }

    if (result.status === "error" || result.status === "expired") {
      throw new Error(result.error || "后台问答任务失败或已过期");
    }
    if (!resultResponse.ok) {
      throw new Error(result.error || "后台任务状态查询失败（HTTP " + resultResponse.status + "）");
    }

    if (result.status === "done") {
      if (result.conversation_id) state.conversationId = result.conversation_id;
      bubbleEl.classList.remove("loading");
      bubbleEl.textContent = result.answer || "Dify 没有返回可显示的答案";
      if (Array.isArray(result.retriever_resources) && result.retriever_resources.length) {
        appendCitations(bubbleEl, result.retriever_resources);
      }
      return;
    }
    bubbleEl.textContent = "正在检索知识库并生成回答…";
  }
  throw new Error("等待回答超过 8 分钟。请检查 Netlify 后台任务日志。");
}

function appendCitations(bubbleEl, resources) {
  const names = [...new Set(resources.map((item) => item.document_name || item.dataset_name).filter(Boolean))];
  if (names.length === 0) return;

  const block = document.createElement("div");
  block.className = "citations";
  block.innerHTML = `<strong>引用来源：</strong>${names.slice(0, 4).join(" · ")}`;
  bubbleEl.appendChild(block);
}

function appendMessage(role, text, options = {}) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "我" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (options.loading) bubble.classList.add("loading");
  bubble.textContent = text;

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  els.messages.appendChild(wrapper);
  els.messages.scrollTop = els.messages.scrollHeight;

  return bubble;
}

function onKeyDown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.composerForm.requestSubmit();
  }
}

function autoResize() {
  this.style.height = "auto";
  this.style.height = `${Math.min(this.scrollHeight, 140)}px`;
}

function getOrCreateUserId() {
  const key = "dify-demo-user-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(key, id);
  }
  return id;
}
