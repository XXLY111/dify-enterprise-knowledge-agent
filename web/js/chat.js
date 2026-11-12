const API_CHAT = "/.netlify/functions/dify-chat";
const API_CONFIG = "/.netlify/functions/dify-config";
const API_HISTORY = "/.netlify/functions/dify-history";

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
  const response = await fetch(API_CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      conversation_id: state.conversationId,
      user: state.userId,
      response_mode: "streaming",
    }),
  });

  if (!response.ok) {
    let detail = "服务暂时不可用";
    try {
      const data = await response.json();
      detail = data.error || data.detail || detail;
      if (data.hint) detail += `（${data.hint}）`;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const data = await response.json();
    bubbleEl.classList.remove("loading");
    bubbleEl.textContent = data.answer || JSON.stringify(data);
    if (data.conversation_id) state.conversationId = data.conversation_id;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let retrieverResources = [];
  let messageId = "";
  let streamFinished = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if (event.conversation_id) {
        state.conversationId = event.conversation_id;
      }
      if (event.message_id) messageId = event.message_id;
      if (event.event === "message_end" || event.event === "workflow_finished") streamFinished = true;

      if (typeof event.answer === "string") {
        if (event.event === "message" || event.event === "agent_message") {
          answer += event.answer;
        } else if (!event.event && event.answer) {
          answer = event.answer;
        }
        bubbleEl.textContent = answer;
      }

      if (event.event === "message_end" && event.metadata?.retriever_resources) {
        retrieverResources = event.metadata.retriever_resources;
      }
    }
  }

  bubbleEl.classList.remove("loading");

  // Fall back to completed conversation history when streaming closes early.
  if ((!answer || !streamFinished) && state.conversationId) {
    bubbleEl.textContent = answer || "工作流仍在执行，正在获取完整回答…";
    const recovered = await recoverFromHistory(query, messageId);
    if (recovered?.answer) {
      answer = recovered.answer;
      bubbleEl.textContent = answer;
      retrieverResources = recovered.retriever_resources || retrieverResources;
    }
  }

  if (!answer) {
    bubbleEl.textContent = "未能获取回答。请检查 Dify 日志或稍后重新提问。";
    return;
  }

  if (retrieverResources.length > 0) {
    appendCitations(bubbleEl, retrieverResources);
  }
}

async function recoverFromHistory(query, messageId) {
  const params = new URLSearchParams({
    conversation_id: state.conversationId,
    user: state.userId,
    message_id: messageId,
    query,
  });
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`${API_HISTORY}?${params}`, { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        if (data.ready && typeof data.answer === "string" && data.answer.trim()) {
          return data;
        }
      } else if (response.status === 401 || response.status === 403) {
        break;
      }
    } catch {
      // Retry transient errors while the Dify workflow finishes.
    }
    if (i < 39) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
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
