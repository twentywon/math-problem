// mathgen.html 브라우저 통합 테스트 (Playwright).
// CDN 은 로컬 npm 패키지로, AI API(Claude·OpenAI·Gemini)는 가짜 응답으로 대체한다.
// 사용: node tests/e2e_html.js <libs 폴더(katex, pdfjs, jszip, xlsx 패키지)> <mathgen.html 절대경로> <group.pdf> <출력 폴더>
const { chromium } = require("playwright");
const fs = require("fs");
const [K, HTML, PDF, OUT] = process.argv.slice(2);

function local(url) {
  if (url.includes("katex@0.16.11/")) return `${K}/package/${url.split("katex@0.16.11/")[1]}`;
  if (url.includes("pdf.js/3.11.174/")) { const t = url.split("3.11.174/")[1]; return `${K}/pdfjs/package/${/^(cmaps|standard_fonts)/.test(t) ? "" : "build/"}${t}`; }
  if (url.includes("jszip/")) return `${K}/jszip/package/dist/jszip.min.js`;
  if (url.includes("xlsx/")) return `${K}/xlsx/package/dist/xlsx.full.min.js`;
}
const units = ["CM1-2-2", "CM2-1-3", "ALG-1-1", "CM1-2-3"];
let nClass = 0;
function answerFor(system, user) {
  if (system.includes("연결 확인")) return {ok: true};
  if (system.includes("검토자")) return {answer: user.includes("B형") ? "2" : "3", well_posed: true, issues: "", solution_brief: "..."};
  if (system.includes("출제 경험")) return {problems: [
    {kind: "유사문제", title: "넓이 최대", statement: "이차함수 $y=-x(x-8)$ 위의 점 P 에 대하여 삼각형 OAP 넓이가 최대일 때 P 의 y좌표는?", choices: ["$12$", "$14$", "$16$", "$18$", "$20$"], figure_description: "", answer: "3", solution: "꼭짓점에서 최대", shared_concepts: ["이차함수 최대"], relation_to_original: "수치 변경", unit_id: "CM1-2-2", difficulty: 2},
    {kind: "개념연계문제", title: "B형", statement: "원 $x^2+y^2=25$ 위의 점과 지름의 양 끝이 이루는 각은?", choices: [], figure_description: "", answer: "90", solution: "...", shared_concepts: ["원주각"], relation_to_original: "직각 조건", unit_id: "CM2-1-3", difficulty: 3}]};
  if (system.includes("수능 수학 전문가")) return {answer: user.includes("13번") ? "4" : "3", solution: "$f(x)$ 를 정리하면 ...", confidence: "high"};
  return {transcription: "함수 $y=-x(x-6)$ ...", figure_description: "", question_type: "5지선다", primary_unit_id: units[(nClass++) % units.length],
    secondary_unit_ids: [], key_concepts: ["이차함수의 최대·최소"], solution_approach: "꼭짓점을 찾는다.", answer: "3", solution: "...", difficulty: 3};
}
const sse = obj => {
  const text = JSON.stringify(obj), h = Math.floor(text.length / 2);
  const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
  return ev("message_start", {type: "message_start", message: {id: "m", content: []}})
    + ev("content_block_delta", {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: text.slice(0, h)}})
    + ev("content_block_delta", {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: text.slice(h)}})
    + ev("message_delta", {type: "message_delta", delta: {stop_reason: "end_turn"}}) + ev("message_stop", {type: "message_stop"});
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({viewport: {width: 1300, height: 900}, acceptDownloads: true});
  const calls = [], errors = [];
  await ctx.route(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/, r => {
    const f = local(r.request().url());
    return f && fs.existsSync(f) ? r.fulfill({path: f, headers: {"access-control-allow-origin": "*"}}) : r.fulfill({status: 404});
  });
  const cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "*"};
  await ctx.route("https://api.anthropic.com/**", r => {
    const body = JSON.parse(r.request().postData() || "{}");
    calls.push({p: "anthropic", h: r.request().headers(), body});
    const user = body.messages[0].content.filter(c => c.type === "text").map(c => c.text).join("");
    r.fulfill({status: 200, headers: {...cors, "content-type": "text/event-stream"}, body: sse(answerFor(body.system[0].text, user))});
  });
  await ctx.route("https://api.openai.com/**", r => {
    const url = r.request().url();
    if (url.endsWith("/models")) return r.fulfill({status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({data: [{id: "gpt-test-vision"}, {id: "gpt-mini"}]})});
    const body = JSON.parse(r.request().postData());
    calls.push({p: "openai", h: r.request().headers(), body});
    const user = body.messages[1].content.filter(c => c.type === "text").map(c => c.text).join("");
    r.fulfill({status: 200, headers: cors, contentType: "application/json",
      body: JSON.stringify({choices: [{message: {content: JSON.stringify(answerFor(body.messages[0].content, user))}, finish_reason: "stop"}]})});
  });
  await ctx.route("https://generativelanguage.googleapis.com/**", r => {
    const url = r.request().url();
    if (/\/models\?/.test(url)) return r.fulfill({status: 200, headers: cors, contentType: "application/json",
      body: JSON.stringify({models: [{name: "models/gemini-test", supportedGenerationMethods: ["generateContent"]}, {name: "models/embed", supportedGenerationMethods: ["embedContent"]}]})});
    const body = JSON.parse(r.request().postData());
    calls.push({p: "gemini", url, body});
    const user = body.contents[0].parts.filter(p => p.text).map(p => p.text).join("");
    r.fulfill({status: 200, headers: cors, contentType: "application/json",
      body: JSON.stringify({candidates: [{content: {parts: [{text: "```json\n" + JSON.stringify(answerFor(body.systemInstruction.parts[0].text, user)) + "\n```"}]}, finishReason: "STOP"}]})});
  });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", d => d.accept());
  await page.goto("file://" + HTML);

  // 1) Claude 설정
  await page.click("nav button[data-tab=settings]");
  await page.selectOption("#s-provider", "anthropic");
  await page.fill("#s-key", "sk-ant-test"); await page.click("#s-save");
  console.log("pill:", await page.textContent("#ai-label"));

  // 2) 공통 자료가 있는 PDF 넣기 (분류 + 교차 풀이)
  await page.click("nav button[data-tab=ingest]");
  await page.check("#auto-solve");
  await page.setInputFiles("#file", PDF);
  await page.waitForFunction(() => /완료|오류/.test(document.querySelector(".status")?.textContent || "") && !/AI 처리 중|자르기 완료: 문항 \d+개$/.test(document.querySelector(".status").textContent), null, {timeout: 60000});
  console.log("status:", await page.textContent(".status"));
  console.log("log:", (await page.textContent(".log")).split("\n").filter(l => /공통|문항 \d+개/.test(l)).join(" | "));
  console.log("shared tags:", await page.locator(".crops .tag.shared").count());
  await page.screenshot({path: OUT + "/h_ingest.png"});

  // 3) 문항 표
  await page.click("nav button[data-tab=table]");
  const rows = await page.locator("#sheet tbody tr[data-id]").count();
  console.log("table rows:", rows);
  const firstRow = page.locator("#sheet tbody tr[data-id]").first();
  await firstRow.locator("input.off").fill("3"); await firstRow.locator("input.off").dispatchEvent("change");
  await page.waitForTimeout(200);
  console.log("grade cells:", await page.locator("#sheet td.ok").allTextContents());
  console.log("cross:", await page.locator("#sheet tbody tr").nth(3).locator("td").nth(10).textContent());
  await page.click("#sheet th[data-k=num]"); await page.click("#sheet th[data-k=num]");
  console.log("sorted desc first num:", await page.locator("#sheet tbody tr").first().locator("td").nth(2).textContent());
  await page.check("#t-all");
  await page.fill("#t-sim", "1"); await page.fill("#t-var", "0"); await page.fill("#t-con", "1");
  await page.click("#t-gen");
  await page.waitForFunction(() => /문제 만들기 완료/.test(document.querySelector("#t-status").textContent), null, {timeout: 30000});
  console.log("bulk gen:", await page.textContent("#t-status"));
  await page.screenshot({path: OUT + "/h_table.png", fullPage: true});
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#t-xlsx")]);
  await dl.saveAs(OUT + "/table.xlsx");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#t-csv")]);
  await dl2.saveAs(OUT + "/table.csv");

  // 4) OpenAI 로 전환: 모델 목록, 연결 테스트, 다시 분류
  await page.click("nav button[data-tab=settings]");
  await page.selectOption("#s-provider", "openai");
  await page.fill("#s-key", "sk-openai-test");
  await page.click("#s-list"); await page.waitForFunction(() => /불러왔습니다|못했/.test(document.querySelector("#s-msg").textContent));
  console.log("openai list:", await page.textContent("#s-msg"));
  await page.fill("#s-model", "gpt-test-vision"); await page.click("#s-save");
  await page.click("#s-test"); await page.waitForFunction(() => /연결되었습니다|오류|못/.test(document.querySelector("#s-msg").textContent));
  console.log("openai test:", await page.textContent("#s-msg"));
  await page.click("nav button[data-tab=table]");
  await page.locator("#sheet .open").first().click();
  await page.click("#detail .resolve");
  await page.waitForTimeout(800);
  console.log("openai solve box:", (await page.locator("#detail .box").textContent()).replace(/\s+/g, " ").slice(0, 80));
  await page.click("#detail .close");

  // 5) Gemini 로 전환
  await page.click("nav button[data-tab=settings]");
  await page.selectOption("#s-provider", "gemini");
  await page.fill("#s-key", "AIza-test");
  await page.click("#s-list"); await page.waitForFunction(() => /불러왔습니다|못했/.test(document.querySelector("#s-msg").textContent));
  console.log("gemini list:", await page.textContent("#s-msg"), await page.locator("#s-models option").count());
  await page.fill("#s-model", "gemini-test"); await page.click("#s-save");
  await page.click("#s-test"); await page.waitForFunction(() => /연결되었습니다|오류|못/.test(document.querySelector("#s-msg").textContent));
  console.log("gemini test:", await page.textContent("#s-msg"));
  // 다시 Claude 로 돌아가면 키가 남아 있는지
  await page.selectOption("#s-provider", "anthropic");
  console.log("claude key kept:", await page.inputValue("#s-key") === "sk-ant-test", await page.inputValue("#s-model"));

  const a = calls.find(c => c.p === "anthropic"), o = calls.find(c => c.p === "openai" && c.body.messages[1].content.some(x => x.type === "image_url")), g = calls.find(c => c.p === "gemini");
  console.log("anthropic req:", a.h["anthropic-version"], a.h["anthropic-beta"], a.body.fallbacks, a.body.output_config?.format?.type, a.body.thinking?.type);
  console.log("openai req:", o.body.model, o.body.response_format.type, o.body.response_format.json_schema?.strict, o.h.authorization?.slice(0, 12));
  console.log("gemini req:", /gemini-test:generateContent\?key=AIza-test/.test(g.url), g.body.generationConfig.responseMimeType);
  console.log("calls:", calls.length, "errors:", errors.length ? errors : "none");
  await b.close();
})();
