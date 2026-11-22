// 브라우저 통합 테스트 (Playwright). CDN 은 로컬 npm 패키지로, AI 는 가짜 응답으로 대체한다.
//
//   node tests/e2e_html.js html     <libs> <mathgen.html 절대경로> <tests/fixtures/group.pdf> <출력 폴더>
//   node tests/e2e_html.js artifact   <libs> <아티팩트 폴더(node tools/build-artifact.js 결과)> <tests/fixtures/group.pdf> <출력 폴더>
// 같은 폴더의 first.pdf, sample.pdf 도 쓴다. 확인이 하나라도 실패하면 종료 코드 1.
//
// <libs>: npm pack 으로 받아 푼 katex(package/), pdfjs(pdfjs/package/), jszip(jszip/package/), xlsx(xlsx/package/) 가 있는 폴더
const { chromium } = require("playwright");
const fs = require("fs");
const http = require("http");
const path = require("path");
const [MODE, K, TARGET, PDF, OUT] = process.argv.slice(2);

function local(url) {
  if (url.includes("katex@0.16.11/")) return `${K}/package/${url.split("katex@0.16.11/")[1]}`;
  if (url.includes("pdf.js/3.11.174/")) { const t = url.split("3.11.174/")[1]; return `${K}/pdfjs/package/${/^(cmaps|standard_fonts)/.test(t) ? "" : "build/"}${t}`; }
  if (url.includes("jszip/")) return `${K}/jszip/package/dist/jszip.min.js`;
  if (url.includes("xlsx/")) return `${K}/xlsx/package/dist/xlsx.full.min.js`;
}
// 가짜 AI: 지시문 내용으로 어떤 작업인지 구분해 그럴듯한 JSON 을 돌려준다
const units = ["CM1-2-2", "CM2-1-3", "ALG-1-1", "CM1-2-3"];
let nClass = 0, anchored = 0;
function answerFor(prompt) {
  if (prompt.includes("연결 확인")) return {ok: true};
  if (prompt.includes("레이아웃을 읽는 도구")) return {columns: [{x0: 0, x1: 1000}], problems: [{number: 1, column: 0, y_top: 30}, {number: 2, column: 0, y_top: 520}], groups: [], column_bottoms: [990]};
  if (prompt.includes("검토자")) {
    const n = (prompt.match(/\[문제 \d+\]/g) || []).length;
    return {items: Array.from({length: n}, (_, i) => ({index: i + 1, answer: i === 1 ? "7" : "3", well_posed: true, issues: ""}))};
  }
  if (prompt.includes("출제 경험")) return {problems: [
    {kind: "유사문제", title: "넓이가 최대인 삼각형", statement: "이차함수 $y=-x(x-8)$ 의 그래프 위의 점 P 에 대하여 삼각형 OAP 의 넓이가 최대일 때, 점 P 의 $y$좌표는?",
      choices: ["$12$", "$14$", "$16$", "$18$", "$20$"], figure_description: "", answer: "3",
      solution_steps: ["밑변 $\\overline{OA}=8$ 은 고정이므로 높이가 최대일 때 넓이가 최대이다.", "높이는 점 P 의 $y$좌표이고, $y=-(x-4)^2+16$ 이므로 최댓값은 $16$ 이다.", "따라서 정답은 ③ $16$ 이다."],
      shared_concepts: ["이차함수의 최대"], relation_to_original: "함수만 바꾸고 같은 방법으로 푼다", unit_id: "CM1-2-2", difficulty: 2},
    {kind: "개념연계문제", title: "지름 위의 원주각", statement: "원 $x^2+y^2=25$ 위의 점 P 와 지름의 양 끝 A, B 에 대하여 $\\angle APB$ 의 크기(도)는?",
      choices: [], figure_description: "", answer: "90", solution_steps: ["지름에 대한 원주각은 직각이다.", "따라서 $90$ 이다."],
      shared_concepts: ["원주각"], relation_to_original: "직각 조건을 원으로 바꿔 본다", unit_id: "CM2-1-3", difficulty: 3}]};
  if (prompt.includes("수능 수학 전문가")) return {answer: prompt.includes("13번") ? "4" : "3", key_idea: "밑변이 고정이면 높이가 최대일 때 넓이가 최대이다.",
    steps: ["$A(6,0)$ 이므로 밑변 $\\overline{OA}=6$ 이다.", "높이는 점 P 의 $y$좌표 $-t(t-6)$ 이다.", "$-t(t-6)=-(t-3)^2+9$ 이므로 $t=3$ 일 때 최대 $9$ 이다."], confidence: "high"};
  const nums = [...prompt.matchAll(/이미지 \d+: .*? (\d+)번/g)].map(m => +m[1]);
  const n = Math.max(1, nums.length);
  if (prompt.includes("이미 저장된 문항들의 난이도다")) anchored++;
  return {items: Array.from({length: n}, (_, i) => ({index: i + 1, points: (nums[i] || 1) > 20 ? 4 : (nums[i] || 1) > 8 ? 3 : 2, difficulty_score: Math.min(10, 1 + ((nums[i] || 1) * 7) % 10), transcription: "함수 $y=-x(x-6)$ 의 그래프 ...", figure_description: "", question_type: "5지선다",
    primary_unit_id: units[(nClass++) % units.length], secondary_unit_ids: ["CM2-1-1"], key_concepts: ["이차함수의 최대·최소", "삼각형의 넓이"],
    solution_approach: "밑변을 고정하고 높이를 이차함수로 나타내 꼭짓점에서 최댓값을 찾는다.", answer: "3",
    solution_steps: ["점 A 의 좌표를 구한다: $A(6,0)$.", "넓이 $S=\\frac12\\cdot 6\\cdot y_P$ 이다.", "$y_P$ 의 최댓값은 꼭짓점의 $y$좌표 $9$ 이다."], difficulty: 3}))};
}
const sse = obj => {
  const text = JSON.stringify(obj), h = Math.floor(text.length / 2);
  const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
  return ev("content_block_delta", {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: text.slice(0, h)}})
    + ev("content_block_delta", {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: text.slice(h)}})
    + ev("message_delta", {type: "message_delta", delta: {stop_reason: "end_turn"}}) + ev("message_stop", {type: "message_stop"});
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({viewport: {width: 1320, height: 920}, acceptDownloads: true});
  const errors = [], calls = [];
  await ctx.route(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/, r => {
    const f = local(r.request().url());
    return f && fs.existsSync(f) ? r.fulfill({path: f, headers: {"access-control-allow-origin": "*"}}) : r.fulfill({status: 404});
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({status: 200, contentType: "text/css", body: ""}));
  const cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "*"};
  await ctx.route("https://api.anthropic.com/**", r => {
    const body = JSON.parse(r.request().postData() || "{}");
    calls.push({p: "anthropic", h: r.request().headers(), body});
    const prompt = body.system[0].text + body.messages[0].content.filter(c => c.type === "text").map(c => c.text).join("");
    r.fulfill({status: 200, headers: {...cors, "content-type": "text/event-stream"}, body: sse(answerFor(prompt))});
  });
  await ctx.route("https://api.openai.com/**", r => {
    if (r.request().url().endsWith("/models")) return r.fulfill({status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({data: [{id: "gpt-test-vision"}]})});
    const body = JSON.parse(r.request().postData());
    calls.push({p: "openai", h: r.request().headers(), body});
    const prompt = body.messages[0].content + body.messages[1].content.filter(c => c.type === "text").map(c => c.text).join("");
    r.fulfill({status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({choices: [{message: {content: JSON.stringify(answerFor(prompt))}, finish_reason: "stop"}]})});
  });
  await ctx.route("https://generativelanguage.googleapis.com/**", r => {
    const url = r.request().url();
    if (/\/models\?/.test(url)) return r.fulfill({status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({models: [{name: "models/gemini-test", supportedGenerationMethods: ["generateContent"]}]})});
    const body = JSON.parse(r.request().postData());
    calls.push({p: "gemini", url, body});
    const prompt = body.systemInstruction.parts[0].text + body.contents[0].parts.filter(p => p.text).map(p => p.text).join("");
    r.fulfill({status: 200, headers: cors, contentType: "application/json",
      body: JSON.stringify({candidates: [{content: {parts: [{text: "```json\n" + JSON.stringify(answerFor(prompt)) + "\n```"}]}, finishReason: "STOP"}]})});
  });

  let url = "file://" + TARGET, server = null;
  if (MODE === "artifact") {
    // 아티팩트 뼈대를 씌워 로컬 서버로 띄우고, window.claude 를 흉내 낸다
    server = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/" || p === "/index.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${fs.readFileSync(path.join(TARGET, "mathgen-artifact.html"), "utf8")}</body></html>`);
      }
      const f = path.join(TARGET, p);
      if (fs.existsSync(f)) return res.end(fs.readFileSync(f));
      res.statusCode = 404; res.end();
    }).listen(8799);
    url = "http://localhost:8799/";
    // 아티팩트 저장소의 이미지 주소(_blob)는 1×1 PNG 로 응답한다
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
    await ctx.route("**/_blob/**", r => r.fulfill({body: png, contentType: "image/png"}));
    await ctx.exposeBinding("__answerFor", (_, prompt) => answerFor(prompt));
    await ctx.addInitScript(() => {
      const docs = {exams: new Map(), problems: new Map()}, subs = {exams: [], problems: []};
      const snap = c => ({docs: [...docs[c].entries()].map(([id, v]) => ({id, exists: true, data: () => JSON.parse(JSON.stringify(v)), metadata: {fromCache: false}})), metadata: {fromCache: false, hasPendingWrites: false}});
      const fire = c => setTimeout(() => subs[c].forEach(f => f(snap(c))), 5);
      const db = {collection: c => ({onSnapshot: n => { subs[c].push(n); fire(c); return () => {}; }, doc: id => ({set: async v => { docs[c].set(id, v); fire(c); }, delete: async () => { docs[c].delete(id); fire(c); }})})};
      const assets = {upload: async blob => ({id: "a" + Math.random().toString(16).slice(2), url: URL.createObjectURL(blob), sizeBytes: blob.size, contentType: blob.type}), delete: async () => {}};
      window.__calls = []; window.__saved = [];
      const sample = async () => ({text: ""});
      sample.limits = async () => ({maxPromptBytes: 262144, images: {maxCount: 5, maxInputBytes: 2e7, mediaTypes: ["image/png", "image/jpeg"]}, modelTiers: ["default", "complex", "quick"]});
      sample.json = async (prompt, opts) => { window.__calls.push({imgs: (opts.images || []).length, tier: opts.modelTier, cache: opts.cache}); return window.__answerFor(prompt); };
      const downloads = {save: async ({filename, data}) => { window.__saved.push([filename, data.size || data.length]); return {status: "saved"}; }};
      const map = {sample, db, assets, downloads};
      window.claude = {use: async n => map[n] || null};
    });
  }

  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(url);
  // 자르기 회귀 확인 (텍스트 분석, AI 없이)
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  const FIX = path.dirname(PDF);
  const split = f => page.evaluate(async b64 => {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const r = await splitPdf(buf, "text", () => {});
    return r.crops.map(c => ({n: c.number, sec: c.section, shared: c.shared || "", rect: c.rect}));
  }, fs.readFileSync(path.join(FIX, f)).toString("base64"));
  await page.waitForFunction(() => window.pdfjsLib && typeof splitPdf === "function");
  const first = await split("first.pdf"), group = await split("group.pdf"), sample = await split("sample.pdf");
  check(first.map(c => c.n).join() === "1,2,3,4", "first.pdf: 1~4번을 모두 찾아야 함 → " + first.map(c => c.n).join());
  check(first[0] && first[0].rect[2] >= 728 / 2 - 6, "first.pdf: 글자보다 넓은 조건 상자가 잘리지 않아야 함");
  check(first[1] && first[1].rect[3] < 1031 - 70, "first.pdf: 2번 영역이 쪽 번호 상자 위에서 끝나야 함");
  check(first[1] && first[1].rect[2] < 728 / 2 + 30, "first.pdf: 2번이 왼쪽 단 폭이어야 함 (오른쪽 단 4번이 섞이면 안 됨)");
  check(group.map(c => `${c.n}${c.shared}`).join() === "10,1111~12,1211~12,13", "group.pdf: 공통 자료는 11·12번에만 → " + group.map(c => `${c.n}${c.shared}`).join());
  check(sample.length === 20 && sample.filter(c => c.sec === 1).length === 4, "sample.pdf: 20문항, 다시 시작하는 구간 4문항 → " + sample.map(c => c.n).join());
  console.log("split checks:", fails.length ? fails : "ok");
  const saved = [];
  page.on("download", async d => { saved.push(d.suggestedFilename()); await d.saveAs(path.join(OUT, d.suggestedFilename())); });

  if (MODE === "html") {
    await page.click("nav.tabs button[data-tab=settings]");
    await page.selectOption("#s-provider", "anthropic");
    await page.fill("#s-key", "sk-ant-test"); await page.click("#s-save");
  }
  await page.waitForFunction(() => !document.querySelector("#drop").classList.contains("disabled"), null, {timeout: 15000});
  console.log("pill:", await page.textContent("#ai-label"));
  // 시험 이름 정렬: 글자순, 글자 속 숫자는 크기순
  const order = await page.evaluate(() => ["2016 고1 3월", "2015 고1 11월", "나 시험", "2015 고1 3월", "가 시험", "2015 고1 9월"].sort(byName).join(" | "));
  console.log("name order:", order);
  if (order !== "2015 고1 3월 | 2015 고1 9월 | 2015 고1 11월 | 2016 고1 3월 | 가 시험 | 나 시험") fails.push("시험 이름 정렬: " + order);
  await page.click("nav.tabs button[data-tab=ingest]");
  await page.screenshot({path: `${OUT}/${MODE}-0-empty.png`});
  await page.check("#auto-solve");
  await page.setInputFiles("#file", PDF);
  await page.waitForFunction(() => /완료|오류/.test(document.querySelector(".status")?.textContent || "") && !/중…|자르기 완료: 문항 \d+개$/.test(document.querySelector(".status").textContent), null, {timeout: 60000});
  console.log("status:", await page.textContent(".status"), "| shared chips:", await page.locator(".crops .chip.blue").count());
  await page.screenshot({path: `${OUT}/${MODE}-1-ingest.png`});

  await page.click("nav.tabs button[data-tab=library]");
  await page.waitForTimeout(300);
  console.log("library:", await page.textContent("#lib-status"));
  await page.screenshot({path: `${OUT}/${MODE}-2-library.png`});

  // 단원 트리 접기·펴기: 과목을 누르면 펼쳐지고 다시 누르면 접힌다
  const cm1 = page.locator('#tree .node[data-k="CM1"]'), cm1kids = page.locator('#tree .node[data-k="CM1"] + .kids');
  const treeState = async () => [await cm1.getAttribute("aria-expanded"), await cm1kids.evaluate(e => e.classList.contains("open")), (await page.textContent("#lib-status")).trim()];
  const t0 = await treeState(); await cm1.click(); await page.waitForTimeout(350);
  const t1 = await treeState();
  await page.screenshot({path: `${OUT}/${MODE}-2b-tree-open.png`});
  await page.locator('#tree .node[data-k="CM1-2"]').click(); await page.waitForTimeout(350);
  const t2 = [await page.locator('#tree .node[data-k="CM1-2"]').getAttribute("aria-expanded"), (await page.textContent("#lib-status")).trim()];
  await cm1.click(); await page.waitForTimeout(350);
  const t3 = await treeState();
  console.log("tree:", JSON.stringify({t0, t1, t2, t3}));
  if (t0[0] !== "false" || t0[1] || t1[0] !== "true" || !t1[1] || t2[0] !== "true" || t3[0] !== "false" || t3[1]) fails.push("단원 트리 접기·펴기");
  await page.locator('#tree .node[data-k=""]').click();
  // 중학교 학년별 단원과 예전 단원 코드 바꾸기
  const ms = await page.evaluate(() => {
    const p = upgradeProblem({id: "x", unitId: "MS-4-3", classification: {primary_unit_id: "MS-4-3", secondary_unit_ids: ["MS-1-3", "CM1-1-1"]}, generated: [{unit_id: "MS-2-7"}, {unit_id: null}]});
    return [p.unitId, p.classification.secondary_unit_ids.join(","), p.generated.map(g => g.unit_id).join(","), UNITS["MS2-3-3"]?.label, TREE.filter(t => t[0].startsWith("MS")).map(t => t[1]).join(",")];
  });
  console.log("middle school:", JSON.stringify(ms));
  if (ms.join("|") !== "MS3-4-1|MS2-1-1,CM1-1-1|MS3-2-1,|중학교 2학년 > 도형과 측정 > 피타고라스 정리|중학교 1학년,중학교 2학년,중학교 3학년") fails.push("중학교 학년별 단원");

  // 문항 상세: 정답·풀이
  await page.locator("#grid .card", {hasText: "11"}).first().click();
  await page.waitForTimeout(400);
  console.log("detail bubbles filled:", await page.locator("#detail .answer-card .bubble.fill").count(), "steps:", await page.locator("#detail ol.steps li").count());
  await page.locator("#detail [data-pick='3']").click(); await page.waitForTimeout(200);
  console.log("grade chip:", await page.locator("#detail .answer-card .chip.ok, #detail .answer-card .chip.bad").last().textContent());
  await page.screenshot({path: `${OUT}/${MODE}-3-answer.png`});
  await page.locator("#detail .seg button[data-t=analysis]").click(); await page.waitForTimeout(200);
  await page.screenshot({path: `${OUT}/${MODE}-4-analysis.png`});
  // 문항 하나의 단원 옮기기: 학년·과목 → 영역 → 중단원
  const curId = await page.evaluate(() => document.querySelector("#detail").dataset.id || null);
  await page.selectOption("#detail .up-subj", "MS2"); await page.selectOption("#detail .up-chap", "3"); await page.selectOption("#detail .up-sec", "MS2-3-3");
  await page.click("#detail .move-unit"); await page.waitForTimeout(300);
  const moved1 = await page.evaluate(() => [...state.problems.values()].filter(p => p.unitManual).map(p => p.unitId));
  console.log("move one:", JSON.stringify(moved1));
  if (moved1.join() !== "MS2-3-3") fails.push("문항 단원 옮기기: " + moved1);
  await page.locator("#detail .seg button[data-t=gen]").click();
  await page.click("#detail .do-gen");
  await page.waitForFunction(() => document.querySelectorAll("#detail .gen").length > 0, null, {timeout: 20000});
  await page.locator("#detail .gen details").first().evaluate(d => d.open = true);
  await page.waitForTimeout(300);
  console.log("gen cards:", await page.locator("#detail .gen").count(), "verify chips:", (await page.locator("#detail .gen .chip.ok, #detail .gen .chip.warn").allTextContents()).join(","));
  await page.screenshot({path: `${OUT}/${MODE}-5-gen.png`});
  await page.click("#detail .next"); await page.waitForTimeout(200);
  console.log("next ->", (await page.textContent("#detail .crumb")).slice(-6));
  await page.click("#detail .close");

  // 문항 표
  await page.click("nav.tabs button[data-tab=table]");
  console.log("table rows:", await page.locator("#sheet tbody tr[data-id]").count());
  await page.check("#t-all"); await page.fill("#t-sim", "1"); await page.fill("#t-var", "0"); await page.fill("#t-con", "0");
  await page.click("#t-gen");
  await page.waitForFunction(() => /문제 만들기 완료/.test(document.querySelector("#t-status").textContent), null, {timeout: 30000});
  console.log("bulk:", await page.textContent("#t-status"));
  await page.screenshot({path: `${OUT}/${MODE}-6-table.png`});
  // 선택 문항 한꺼번에 옮기기
  await page.click("#t-move");
  await page.selectOption("#move .up-subj", "CM2"); await page.selectOption("#move .up-chap", "1"); await page.selectOption("#move .up-sec", "CM2-1-3");
  await page.screenshot({path: `${OUT}/${MODE}-6b-move.png`});
  await page.click("#move-ok"); await page.waitForTimeout(400);
  const moved2 = await page.evaluate(() => [...new Set([...state.problems.values()].map(p => p.unitId))]);
  console.log("move all:", JSON.stringify(moved2), "rows:", await page.locator("#sheet tbody tr[data-id]").count());
  if (moved2.join() !== "CM2-1-3") fails.push("선택 문항 단원 옮기기: " + moved2);
  // 저장소에서 카드를 단원 트리로 끌어다 놓기
  await page.click("nav.tabs button[data-tab=library]");
  await page.evaluate(() => { state.open.add("CM1"); state.open.add("CM1-1"); renderGrid(); });
  await page.waitForTimeout(300);
  const dragId = await page.locator("#grid .card").first().getAttribute("data-id");
  await page.locator("#grid .card").first().dragTo(page.locator('#tree .node[data-k="CM1-1-2"]'));
  await page.waitForTimeout(400);
  const moved3 = await page.evaluate(id => state.problems.get(id).unitId, dragId);
  console.log("drag:", moved3, "tree count:", (await page.locator('#tree .node[data-k="CM1-1-2"] .n').textContent()).trim());
  await page.screenshot({path: `${OUT}/${MODE}-6c-drag.png`});
  if (moved3 !== "CM1-1-2") fails.push("끌어다 놓아 옮기기: " + moved3);
  await page.click("nav.tabs button[data-tab=table]");
  // 직접 옮긴 단원은 다시 분류해도 유지
  await page.click("#t-classify");
  await page.waitForFunction(() => /분류 완료/.test(document.querySelector("#t-status").textContent), null, {timeout: 20000});
  const kept = await page.evaluate(id => state.problems.get(id).unitId, dragId);
  console.log("kept after reclassify:", kept);
  if (kept !== "CM1-1-2") fails.push("다시 분류 후 직접 옮긴 단원 유지: " + kept);
  await page.click("#t-xlsx"); await page.waitForTimeout(800);
  await page.click("#btn-zip").catch(() => {});
  await page.click("nav.tabs button[data-tab=library]"); await page.click("#btn-zip"); await page.waitForTimeout(1500);

  // 같은 시험지 다시 넣기: 교체 + 이어받기
  const before = await page.evaluate(() => [...state.problems.values()].filter(p => p.number === 11).map(p => [p.officialAnswer, (p.generated || []).length])[0]);
  await page.click("nav.tabs button[data-tab=ingest]");
  await page.setInputFiles("#file", PDF);
  await page.waitForSelector("#dup[open]");
  console.log("dup:", await page.textContent("#dup-msg"));
  await page.click("#dup-replace");
  await page.waitForFunction(() => /완료|모두 처리/.test(document.querySelector(".status")?.textContent || ""), null, {timeout: 60000});
  console.log("replace:", (await page.textContent(".log")).split("\n").find(l => l.includes("교체")));
  const after = await page.evaluate(() => [...state.problems.values()].filter(p => p.number === 11).map(p => [p.officialAnswer, (p.generated || []).length])[0]);
  console.log("problems:", await page.evaluate(() => state.problems.size), "exams:", await page.evaluate(() => state.exams.size), "#11 before/after:", JSON.stringify(before), JSON.stringify(after));
  // 10문항 이상: 상대 난이도
  await page.setInputFiles("#file", path.join(path.dirname(PDF), "sample.pdf"));
  await page.waitForFunction(() => /단원 분류·풀이 완료|완료 \(/.test(document.querySelector(".status")?.textContent || ""), null, {timeout: 60000});
  const levels = await page.evaluate(() => { const c = {}; for (const p of state.problems.values()) { const l = diffLevel(p); c[l] = (c[l] || 0) + 1; } return c; });
  console.log("relative levels:", JSON.stringify(levels), "anchored classify calls:", anchored);
  await page.click("nav.tabs button[data-tab=library]"); await page.locator("#grid .card").last().click(); await page.locator("#detail .seg button[data-t=analysis]").click();
  console.log("analysis:", (await page.locator("#detail .kv dd").nth(1).textContent()).replace(/\s+/g, " ").trim());
  await page.screenshot({path: `${OUT}/${MODE}-9-difficulty.png`}); await page.click("#detail .close");

  if (MODE === "html") {
    await page.click("nav.tabs button[data-tab=settings]");
    await page.selectOption("#s-provider", "openai"); await page.fill("#s-key", "sk-openai-test");
    await page.click("#s-list"); await page.waitForFunction(() => /불러왔습니다|못했/.test(document.querySelector("#s-msg").textContent));
    await page.fill("#s-model", "gpt-test-vision"); await page.click("#s-save");
    await page.click("#s-test"); await page.waitForFunction(() => /연결되었습니다|오류|못/.test(document.querySelector("#s-msg").textContent));
    console.log("openai:", await page.textContent("#s-msg"));
    await page.selectOption("#s-provider", "gemini"); await page.fill("#s-key", "AIza-test"); await page.fill("#s-model", "gemini-test"); await page.click("#s-save");
    await page.click("#s-test"); await page.waitForFunction(() => /연결되었습니다|오류|못/.test(document.querySelector("#s-msg").textContent));
    console.log("gemini:", await page.textContent("#s-msg"));
    await page.selectOption("#s-provider", "anthropic");
    console.log("claude key kept:", await page.inputValue("#s-key") === "sk-ant-test");
    const a = calls.find(c => c.p === "anthropic");
    console.log("anthropic req:", a.h["anthropic-version"], a.h["anthropic-beta"], a.body.fallbacks, a.body.output_config?.format?.type);
    await page.reload(); await page.click("nav.tabs button[data-tab=library]"); await page.waitForTimeout(400);
    console.log("after reload:", await page.textContent("#lib-status"));
    console.log("downloads:", saved.join(", "));
  } else {
    console.log("sample calls:", JSON.stringify(await page.evaluate(() => window.__calls.map(c => `${c.imgs}/${c.tier}${c.cache === false ? "/fresh" : ""}`))));
    console.log("saved:", JSON.stringify(await page.evaluate(() => window.__saved.map(s => s[0]))));
  }
  // 문제 이미지 넣기 (다운로드 버전은 새로고침 뒤 AI 연결을 다시 확인)
  if (MODE === "html") {
    await page.click("nav.tabs button[data-tab=settings]");
    await page.selectOption("#s-provider", "anthropic"); await page.fill("#s-key", "sk-ant-test"); await page.click("#s-save");
    await page.waitForTimeout(300);
  }
  await page.click("nav.tabs button[data-tab=ingest]");
  const mkPng = async (lines, h = 260) => Buffer.from((await page.evaluate(([lines, h]) => {
    const c = document.createElement("canvas"); c.width = 900; c.height = h;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 900, h); g.fillStyle = "#111"; g.font = "28px sans-serif";
    lines.forEach(([t, y]) => g.fillText(t, 40, y)); return c.toDataURL("image/png").split(",")[1];
  }, [lines, h])), "base64");
  // 한글 파일 이름은 경로 대신 버퍼로 넘긴다 (Playwright 가 한글 경로 파일을 넘기지 못하는 경우가 있다)
  const png = async (name, ...a) => ({name, mimeType: "image/png", buffer: await mkPng(...a)});
  const imgA = await png("문제_7.png", [["7. x² - 5x + 6 = 0 의 두 근의 합은?", 80], ["① 1  ② 3  ③ 5  ④ 6  ⑤ 7", 160]]);
  const imgB = await png("캡처.png", [["함수 f(x) = 2x + 1 에 대하여 f(3) 의 값은?", 80]]);
  const imgC = await png("추가.png", [["삼각형 ABC 에서 AB = 3, BC = 4, ∠B = 90° 일 때 CA 는?", 80]]);
  const imgD = await png("두문제.png", [["1. 첫 번째 문제입니다. 2 + 3 의 값은?", 60], ["2. 두 번째 문제입니다. 4 × 5 의 값은?", 600]], 1100);
  const lastJob = () => page.evaluate(() => { const j = document.querySelector("#jobs > .panel"); return j ? j.querySelector(".status").textContent : ""; });
  // 새 작업 칸이 생기고 그 칸이 끝날 때까지 기다린다 (넣기 전에 jobsBefore() 를 불러 둔다)
  let nJobs = 0;
  const jobsBefore = async () => { nJobs = await page.locator("#jobs > .panel").count(); };
  const waitJob = async () => {
    try { await page.waitForFunction(n => document.querySelectorAll("#jobs > .panel").length > n && /완료|오류|넣지 않았/.test(document.querySelector("#jobs > .panel .status")?.textContent || ""), nJobs, {timeout: 30000}); }
    catch (e) { console.log("job timeout; errors so far:", errors); throw e; }
    await page.waitForTimeout(300); return lastJob();
  };
  const imgExam = () => page.evaluate(() => { const e = [...state.exams.values()].filter(e => e.kind === "images").sort((a, b) => a.addedAt < b.addedAt ? -1 : 1)[0];
    return e ? {id: e.id, title: e.title, nums: [...state.problems.values()].filter(p => p.examId === e.id).sort((a, b) => a.order - b.order).map(p => p.number)} : null; });
  // ① 두 장을 한 번에: 한 출처, 번호는 파일 이름(7) → 이어서 8
  await jobsBefore(); await page.setInputFiles("#file", [imgA, imgB]);
  const st1 = await waitJob(), ex1 = await imgExam();
  console.log("images:", st1, JSON.stringify(ex1));
  if (!ex1 || ex1.nums.join() !== "7,8" || !/이미지 2장/.test(ex1.title)) fails.push("이미지 넣기: " + JSON.stringify(ex1));
  await page.screenshot({path: `${OUT}/${MODE}-10-images.png`});
  // ② 같은 출처에 추가: 번호 9
  await page.focus("#img-target"); await page.selectOption("#img-target", ex1.id, {timeout: 5000});
  await jobsBefore(); await page.setInputFiles("#file", [imgC]);
  await waitJob(); const ex2 = await imgExam();
  console.log("append:", JSON.stringify(ex2.nums), "exams:", await page.evaluate(() => [...state.exams.values()].filter(e => e.kind === "images").length));
  if (ex2.nums.join() !== "7,8,9") fails.push("이미지 추가: " + ex2.nums);
  // ③ 같은 이미지를 다시 넣으면 건너뜀
  await jobsBefore(); await page.setInputFiles("#file", [imgA]);
  const st3 = await waitJob(); const ex3 = await imgExam();
  console.log("dup image:", st3, JSON.stringify(ex3.nums));
  if (ex3.nums.join() !== "7,8,9" || !/이미 저장된 이미지/.test(st3)) fails.push("같은 이미지 건너뛰기: " + st3);
  // ④ 한 장에 두 문제: AI 로 나누기 (새 출처)
  await page.selectOption("#img-target", "");
  await page.check("#img-split");
  await jobsBefore(); await page.setInputFiles("#file", [imgD]);
  const st4 = await waitJob();
  const splitNos = await page.evaluate(() => { const e = [...state.exams.values()].find(e => e.title === "두문제"); return e ? [...state.problems.values()].filter(p => p.examId === e.id).map(p => p.number).sort().join() : ""; });
  console.log("image split:", st4, splitNos);
  if (splitNos !== "1,2") fails.push("이미지 여러 문제 나누기: " + splitNos);
  await page.uncheck("#img-split");
  // ⑤ 붙여넣기
  const nBefore = await page.evaluate(() => state.problems.size); await jobsBefore();
  await page.evaluate(async b64 => {
    const bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bin], "image.png", {type: "image/png"}));
    document.body.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true}));
  }, (await mkPng([["붙여넣은 문제: 3 + 4 의 값은?", 80]])).toString("base64"));
  await waitJob();
  const pasted = await page.evaluate(n => [state.problems.size - n, [...state.exams.values()].some(e => /^붙여넣기_/.test(e.title))], nBefore);
  console.log("paste:", JSON.stringify(pasted));
  if (pasted[0] !== 1 || !pasted[1]) fails.push("붙여넣기: " + pasted);
  console.log("title:", await page.title());
  if (await page.title() !== "수학 문제 도우미") fails.push("제목");

  await page.setViewportSize({width: 400, height: 820});
  await page.click("nav.tabs button[data-tab=library]");
  console.log("phone scrollWidth:", await page.evaluate(() => document.documentElement.scrollWidth));
  await page.locator("#grid .card").first().click(); await page.waitForTimeout(300);
  await page.screenshot({path: `${OUT}/${MODE}-7-phone.png`});
  await page.click("#detail .close");
  await page.setViewportSize({width: 1320, height: 920}); await page.emulateMedia({colorScheme: "dark"});
  await page.locator("#grid .card").nth(1).click(); await page.waitForTimeout(300);
  await page.screenshot({path: `${OUT}/${MODE}-8-dark.png`});
  console.log("errors:", errors.length ? errors : "none");
  if (errors.length) fails.push("페이지 오류 " + errors.length + "건");
  await b.close(); if (server) server.close();
  if (fails.length) { console.log("FAILED:", fails); process.exitCode = 1; }
})();
