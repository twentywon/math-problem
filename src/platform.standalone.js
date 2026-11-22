"use strict";
/* =====================================================================
   다운로드(단일 HTML) 버전의 플랫폼 부분
   - AI: 설정 탭에서 고른 제공자(Claude, OpenAI, Gemini, OpenAI 호환)를 API 키로 직접 호출
   - 저장: 이 브라우저의 IndexedDB (이미지는 data URL)
   - 파일 저장: 브라우저 다운로드, 폴더 저장(크롬·엣지)
   ===================================================================== */
const PLATFORM = (() => {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  const PROVIDERS = {
    anthropic: {label: "Claude (Anthropic)", short: "Claude", keyHint: "sk-ant-...", defaultModel: "claude-opus-5-5",
      help: "키 발급: platform.claude.com → API Keys. 모델은 claude-opus-5-5 를 권장합니다."},
    openai: {label: "OpenAI (GPT)", short: "OpenAI", keyHint: "sk-...", defaultModel: "",
      help: "키 발급: platform.openai.com → API keys. '모델 목록 불러오기'로 이미지 입력을 지원하는 모델을 고르세요."},
    gemini: {label: "Google Gemini", short: "Gemini", keyHint: "AIza...", defaultModel: "",
      help: "키 발급: aistudio.google.com → Get API key. '모델 목록 불러오기'로 모델을 고르세요."},
    compat: {label: "OpenAI 호환 서버 (OpenRouter, 로컬 등)", short: "호환 서버", keyHint: "키 (필요 없으면 비워 둠)", defaultModel: "",
      help: "OpenAI Chat Completions 형식을 따르는 서버의 Base URL 과 모델 이름을 넣으세요. 문항 이미지를 읽을 수 있는(비전) 모델이어야 합니다."},
  };
  const settings = {provider: "anthropic", keys: {}, models: {anthropic: "claude-opus-5-5"}, baseUrl: "", remember: false, concurrency: 3};
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("mathgen.settings") || "{}");
      if (s.apiKey && !s.keys) s.keys = {anthropic: s.apiKey}; // 이전 버전 설정
      if (s.model && !s.models) s.models = {anthropic: s.model};
      delete s.apiKey; delete s.model;
      Object.assign(settings, s);
      settings.keys = {...(s.keys || {})}; settings.models = {anthropic: "claude-opus-5-5", ...(s.models || {})};
    } catch (e) { /* 저장소 사용 불가 */ }
  }
  function saveSettings() {
    try { localStorage.setItem("mathgen.settings", JSON.stringify({...settings, keys: settings.remember ? settings.keys : {}})); } catch (e) { /* 무시 */ }
    updateStatus();
  }
  const curModel = () => str(settings.models[settings.provider] || PROVIDERS[settings.provider].defaultModel).trim();
  function configured() {
    const p = settings.provider;
    if (!curModel()) return false;
    return p === "compat" ? !!settings.baseUrl.trim() : !!settings.keys[p];
  }

  /* ---------- HTTP ---------- */
  class RetryableError extends Error {}
  function errorMessageFrom(status, text) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.error?.status || j.message || (typeof j.error === "string" ? j.error : text); } catch (e) { /* 원문 */ }
    if (status === 401 || status === 403) msg = `API 키가 올바르지 않거나 권한이 없습니다. 설정을 확인하세요. (${String(msg).slice(0, 160)})`;
    return `AI 오류 ${status}: ${String(msg).slice(0, 400)}`;
  }
  async function httpFetch(url, init) {
    let res;
    try { res = await fetch(url, init); } catch (e) { throw new RetryableError("네트워크 오류: " + e.message); }
    if (res.status === 429 || res.status >= 500) {
      const err = new RetryableError(errorMessageFrom(res.status, await res.text()));
      err.wait = (Number(res.headers.get("retry-after")) || 0) * 1000; throw err;
    }
    if (!res.ok) { const err = new Error(errorMessageFrom(res.status, await res.text())); err.status = res.status; throw err; }
    return res;
  }
  async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (e instanceof RetryableError && attempt < 4) { await sleep(Math.max(e.wait || 0, 2000 * 2 ** attempt)); continue; }
        throw e;
      }
    }
  }

  /* ---------- Claude (Anthropic Messages API, 스트리밍) ---------- */
  const CLAUDE_MODERN = /^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])|^claude-haiku-5/;
  const CLAUDE_FALLBACK = /^claude-(opus-5-5|opus-5$|fable-5-[12]|sonnet-5-5|mythos-5-[12])/;
  async function readSSE(res) {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", text = "", stopReason = null, stopDetails = null;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true}).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text;
          else if (ev.type === "message_delta") { stopReason = ev.delta?.stop_reason ?? stopReason; stopDetails = ev.delta?.stop_details ?? stopDetails; }
          else if (ev.type === "error") {
            const t = ev.error?.type || "", msg = `AI 오류(${t}): ${ev.error?.message || ""}`;
            throw (t === "overloaded_error" || t === "api_error") ? new RetryableError(msg) : new Error(msg);
          }
        }
      }
    }
    return {text, stopReason, stopDetails};
  }
  async function callClaude({key, model, system, content, schema, effort, maxTokens}) {
    const modern = CLAUDE_MODERN.test(model);
    const body = {model, max_tokens: modern ? maxTokens : Math.min(maxTokens, 16000), stream: true,
      system: [{type: "text", text: modern ? system : system + schemaInstruction(schema), cache_control: {type: "ephemeral"}}],
      messages: [{role: "user", content}]};
    if (modern) { body.thinking = {type: "adaptive"}; body.output_config = {effort, format: {type: "json_schema", schema}}; }
    const headers = {"content-type": "application/json", "x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true"};
    if (CLAUDE_FALLBACK.test(model)) { body.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; } // 안전 분류기 거절 시 권장 모델로 자동 재시도
    const res = await httpFetch("https://api.anthropic.com/v1/messages", {method: "POST", headers, body: JSON.stringify(body)});
    const {text, stopReason, stopDetails} = await readSSE(res);
    if (stopReason === "refusal") throw new Error(`AI 가 요청을 거절했습니다 (${stopDetails?.category || "사유 미상"})`);
    if (stopReason === "max_tokens") throw new Error("응답이 너무 길어 잘렸습니다. 한 번에 만드는 문제 수를 줄여 보세요.");
    return text;
  }
  /* ---------- OpenAI 및 OpenAI 호환 (Chat Completions) ---------- */
  async function callOpenAI({base, key, model, system, content, schema, strict}) {
    const user = content.map(b => b.type === "image"
      ? {type: "image_url", image_url: {url: `data:${b.source.media_type};base64,${b.source.data}`}}
      : {type: "text", text: b.text});
    const body = {model, messages: [{role: "system", content: system + schemaInstruction(schema)}, {role: "user", content: user}]};
    body.response_format = strict ? {type: "json_schema", json_schema: {name: "result", strict: true, schema}} : {type: "json_object"};
    const headers = {"content-type": "application/json"};
    if (key) headers.authorization = `Bearer ${key}`;
    const url = base.replace(/\/+$/, "") + "/chat/completions";
    let res;
    try { res = await httpFetch(url, {method: "POST", headers, body: JSON.stringify(body)}); }
    catch (e) {
      if (!strict && e.status === 400) { delete body.response_format; res = await httpFetch(url, {method: "POST", headers, body: JSON.stringify(body)}); } // response_format 을 모르는 서버
      else throw e;
    }
    const data = await res.json(), choice = data.choices?.[0];
    if (choice?.message?.refusal) throw new Error("AI 가 요청을 거절했습니다: " + choice.message.refusal);
    if (choice?.finish_reason === "length") throw new Error("응답이 너무 길어 잘렸습니다. 한 번에 만드는 문제 수를 줄여 보세요.");
    const msg = choice?.message?.content;
    return Array.isArray(msg) ? msg.map(m => m.text || "").join("") : str(msg);
  }
  /* ---------- Google Gemini (generateContent) ---------- */
  async function callGemini({key, model, system, content, schema}) {
    const parts = content.map(b => b.type === "image" ? {inlineData: {mimeType: b.source.media_type, data: b.source.data}} : {text: b.text});
    const body = {systemInstruction: {parts: [{text: system + schemaInstruction(schema)}]}, contents: [{role: "user", parts}],
      generationConfig: {responseMimeType: "application/json"}};
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await httpFetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
    const data = await res.json();
    if (data.promptFeedback?.blockReason) throw new Error("AI 가 요청을 거절했습니다: " + data.promptFeedback.blockReason);
    const cand = data.candidates?.[0];
    if (cand?.finishReason === "MAX_TOKENS") throw new Error("응답이 너무 길어 잘렸습니다. 한 번에 만드는 문제 수를 줄여 보세요.");
    if (cand?.finishReason === "SAFETY") throw new Error("AI 가 안전 정책으로 응답을 막았습니다.");
    return (cand?.content?.parts || []).map(p => p.text || "").join("");
  }
  async function ask({system, text, images = [], schema, effort = "high", maxTokens = 64000}) {
    if (!configured()) throw new Error("설정 탭에서 AI 제공자, API 키, 모델을 먼저 입력하세요.");
    const prov = settings.provider, key = str(settings.keys[prov]).trim(), model = curModel();
    const content = [];
    for (const b of images) {
      const d = await blobToDataURL(b);
      content.push({type: "image", source: {type: "base64", media_type: d.slice(5, d.indexOf(";")), data: d.slice(d.indexOf(",") + 1)}});
    }
    content.push({type: "text", text});
    const out = await withRetry(() => {
      if (prov === "anthropic") return callClaude({key, model, system, content, schema, effort, maxTokens});
      if (prov === "openai") return callOpenAI({base: "https://api.openai.com/v1", key, model, system, content, schema, strict: true});
      if (prov === "gemini") return callGemini({key, model, system, content, schema});
      return callOpenAI({base: settings.baseUrl.trim(), key, model, system, content, schema, strict: false});
    });
    return parseLooseJSON(out);
  }
  async function listModels() {
    const prov = settings.provider, key = str(settings.keys[prov]).trim();
    if (prov === "anthropic") {
      const res = await httpFetch("https://api.anthropic.com/v1/models?limit=100", {headers: {"x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true"}});
      return (await res.json()).data.map(m => m.id);
    }
    if (prov === "gemini") {
      const res = await httpFetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
      return (await res.json()).models.filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
    }
    const base = prov === "openai" ? "https://api.openai.com/v1" : settings.baseUrl.trim().replace(/\/+$/, "");
    const res = await httpFetch(base + "/models", {headers: key ? {authorization: `Bearer ${key}`} : {}});
    return (await res.json()).data.map(m => m.id).sort();
  }

  /* ---------- 저장소: IndexedDB ---------- */
  let dbh = null, loaded = false;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const os = (n, m) => dbh.transaction(n, m).objectStore(n);
  const store = {
    kind: "local", readOnly: false,
    ready: () => loaded,
    describe: () => "문항과 만든 문제는 이 브라우저 안(IndexedDB)에 저장됩니다. 브라우저 데이터를 지우면 사라지므로 가끔 '단원별 ZIP 저장'으로 백업하세요. ZIP 은 '백업 불러오기'로 되살릴 수 있습니다.",
    async start(onChange) {
      try {
        dbh = await new Promise((res, rej) => {
          const r = indexedDB.open("mathgen", 1);
          r.onupgradeneeded = () => { r.result.createObjectStore("exams", {keyPath: "id"}); r.result.createObjectStore("problems", {keyPath: "id"}); };
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        for (const e of await req(os("exams", "readonly").getAll())) state.exams.set(e.id, e);
        for (const p of await req(os("problems", "readonly").getAll())) state.problems.set(p.id, p);
      } catch (e) { dbh = null; toast("브라우저 저장소를 열 수 없어 이번에만 임시로 저장합니다. 시크릿 창이 아닌 일반 창에서 여세요."); }
      loaded = true; onChange();
    },
    async saveImage(id, blob) { return {image: await blobToDataURL(blob)}; },
    async putExam(e) { state.exams.set(e.id, e); if (dbh) await req(os("exams", "readwrite").put(e)).catch(() => {}); },
    async putProblem(p) { state.problems.set(p.id, p); if (dbh) await req(os("problems", "readwrite").put(p)).catch(() => {}); },
    async deleteProblem(p) { state.problems.delete(p.id); state.selected.delete(p.id); if (dbh) await req(os("problems", "readwrite").delete(p.id)).catch(() => {}); },
    async deleteExam(id) {
      for (const p of [...state.problems.values()].filter(p => p.examId === id)) await this.deleteProblem(p);
      state.exams.delete(id); if (dbh) await req(os("exams", "readwrite").delete(id)).catch(() => {});
    },
  };

  /* ---------- 설정 화면 ---------- */
  function renderSettingsForm(root) {
    if (root.querySelector("#s-provider")) return; // 입력 중인 값을 지우지 않도록 한 번만 만든다
    root.innerHTML = `
      <div class="panel">
        <h2 style="font-size:18px;margin-bottom:6px">AI 연결</h2>
        <p class="muted">단원 분류, 스캔본 자르기, 문항 풀이, 문제 생성에 쓰는 AI 입니다. 키는 이 컴퓨터의 브라우저에서 선택한 AI 회사로만 전송됩니다.</p>
        <div class="settings-grid">
          <label class="field">AI 제공자<select id="s-provider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select></label>
          <label class="field">API 키<input id="s-key" type="password" autocomplete="off"></label>
          <label class="field">모델<input id="s-model" type="text" list="s-models" placeholder="모델 이름"><datalist id="s-models"></datalist></label>
          <label class="field" id="s-base-wrap">Base URL (OpenAI 호환)<input id="s-base" type="text" placeholder="https://openrouter.ai/api/v1"></label>
          <label class="field">동시 요청 수<input id="s-conc" type="number" min="1" max="8"></label>
        </div>
        <p class="muted" id="s-help" style="margin:10px 0 0"></p>
        <div class="row" style="margin-top:12px">
          <label><input id="s-remember" type="checkbox"> 이 브라우저에 키 기억</label><span class="spacer"></span>
          <button class="btn" id="s-list">모델 목록 불러오기</button><button class="btn" id="s-test">연결 테스트</button><button class="btn primary" id="s-save">저장</button>
        </div>
        <div id="s-msg" class="muted" style="margin-top:8px" role="status"></div>
      </div>`;
    const q = s => root.querySelector(s);
    let shown = settings.provider;
    const fill = () => {
      const p = q("#s-provider").value, info = PROVIDERS[p];
      q("#s-key").value = settings.keys[p] || ""; q("#s-key").placeholder = info.keyHint;
      q("#s-model").value = settings.models[p] || info.defaultModel;
      q("#s-base-wrap").hidden = p !== "compat"; q("#s-help").textContent = info.help; q("#s-models").innerHTML = "";
    };
    const read = () => {
      const p = q("#s-provider").value;
      settings.provider = p; settings.keys[p] = q("#s-key").value.trim(); settings.models[p] = q("#s-model").value.trim();
      settings.baseUrl = q("#s-base").value.trim(); settings.remember = q("#s-remember").checked;
      settings.concurrency = Math.min(8, Math.max(1, +q("#s-conc").value || 3));
    };
    q("#s-provider").value = settings.provider; q("#s-base").value = settings.baseUrl;
    q("#s-remember").checked = settings.remember; q("#s-conc").value = settings.concurrency; fill();
    q("#s-provider").onchange = () => { // 바꾸기 전 제공자의 입력값을 보관한 뒤 새 제공자의 값을 보여 준다
      settings.keys[shown] = q("#s-key").value.trim(); settings.models[shown] = q("#s-model").value.trim();
      shown = settings.provider = q("#s-provider").value; fill(); updateStatus();
    };
    q("#s-save").onclick = () => { read(); saveSettings(); q("#s-msg").textContent = "저장했습니다."; };
    q("#s-list").onclick = async () => {
      read(); q("#s-msg").textContent = "모델 목록을 불러오는 중…";
      try { const ids = await listModels(); q("#s-models").innerHTML = ids.map(i => `<option value="${esc(i)}">`).join(""); q("#s-msg").textContent = `모델 ${ids.length}개를 불러왔습니다. 모델 칸을 눌러 고르세요.`; }
      catch (e) { q("#s-msg").textContent = "불러오지 못했습니다: " + e.message; }
    };
    q("#s-test").onclick = async () => {
      read(); saveSettings(); q("#s-msg").textContent = "연결 확인 중…";
      try {
        const r = await ask({system: "너는 연결 확인용 응답기다.", text: '{"ok": true} 를 JSON 으로 답하라.', effort: "low", maxTokens: 4000,
          schema: {type: "object", additionalProperties: false, required: ["ok"], properties: {ok: {type: "boolean"}}}});
        q("#s-msg").innerHTML = r?.ok === true ? `<span class="ok">연결되었습니다 (${esc(PROVIDERS[settings.provider].label)} · ${esc(curModel())}).</span>` : "응답은 왔지만 형식이 예상과 다릅니다.";
      } catch (e) { q("#s-msg").innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
    };
  }

  async function folderSave(entriesFn) {
    let root; try { root = await window.showDirectoryPicker({mode: "readwrite"}); } catch (e) { return; }
    const b = $("#btn-folder"); b.disabled = true;
    try {
      const entries = await entriesFn();
      for (let i = 0; i < entries.length; i++) {
        const [path, data] = entries[i], parts = path.split("/"); let dir = root;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, {create: true});
        const w = await (await dir.getFileHandle(parts.at(-1), {create: true})).createWritable(); await w.write(data); await w.close();
        b.textContent = `저장 중 ${i + 1}/${entries.length}`;
      }
      toast("저장했습니다. '단원별' 폴더에 단원별로 정리되어 있습니다.");
    } catch (e) { toast("저장 실패: " + e.message); }
    b.disabled = false; b.textContent = "폴더에 단원별 저장";
  }

  return {
    name: "standalone",
    pdfWorker: PDFJS + "pdf.worker.min.js",
    pdfParams: () => ({cMapUrl: PDFJS + "cmaps/", cMapPacked: true, standardFontDataUrl: PDFJS + "standard_fonts/"}),
    async init() { loadSettings(); },
    ai: {
      ready: configured,
      label: () => `${PROVIDERS[settings.provider].short} · ${curModel()}`,
      blockedReason: short => short ? "AI 설정 필요" : "설정 탭에서 AI 제공자와 API 키를 입력하세요.",
      ask, batchSize: () => 1, concurrency: () => Math.max(1, settings.concurrency | 0),
    },
    store,
    canSave: () => true,
    async saveFile(name, data) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return true;
    },
    folderSave: window.showDirectoryPicker ? folderSave : null,
    folderWatch: !!window.showDirectoryPicker,
    settings: {label: "설정", render: renderSettingsForm},
  };
})();
