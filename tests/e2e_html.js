// 브라우저 통합 테스트 (Playwright). CDN 은 로컬 npm 패키지로, AI 는 가짜 응답으로 대체한다.
//
//   node tests/e2e_html.js html     <libs> <mathgen.html 절대경로> <tests/fixtures/group.pdf> <출력 폴더>
//   node tests/e2e_html.js artifact   <libs> <아티팩트 폴더(node tools/build-artifact.js 결과)> <tests/fixtures/group.pdf> <출력 폴더>
// 같은 폴더의 first.pdf, sample.pdf 도 쓴다. 확인이 하나라도 실패하면 종료 코드 1.
//
// <libs>: npm pack 으로 받아 푼 katex(package/), pdfjs(pdfjs/package/), jszip(jszip/package/), xlsx(xlsx/package/), html2canvas(h2c/package/) 가 있는 폴더
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
  if (url.includes("html2canvas/")) return `${K}/h2c/package/dist/html2canvas.min.js`;
}
// 가짜 AI: 지시문 내용으로 어떤 작업인지 구분해 그럴듯한 JSON 을 돌려준다
const units = ["CM1-2-2", "CM2-1-3", "ALG-1-1", "CM1-2-3"];
let nClass = 0, anchored = 0, nMake = 0;
const makePrompts = [];
// ④ 문제 만들기용 가짜 응답: 부를 때마다 서로 다른 문제. 첫 응답의 첫 문제는 저장된 문항을 그대로 옮긴 것 (버려져야 함)
const MAKE_POOL = [
  ["등차수열의 항", "첫째항이 $3$, 공차가 $2$ 인 등차수열 $\\{a_n\\}$ 에 대하여 $a_{10}$ 의 값은?", ["$19$", "$21$", "$23$", "$25$", "$27$"], "2"],
  ["다항식의 나머지", "다항식 $x^3-2x+5$ 를 $x-2$ 로 나눈 나머지를 구하시오.", [], "9"],
  ["복소수의 계산", "$(1+i)^2$ 의 값은? (단, $i=\\sqrt{-1}$)", ["$0$", "$2$", "$2i$", "$-2i$", "$1+i$"], "3"],
  ["연립부등식", "연립부등식 $2x-1>3$, $x+4\\le 10$ 을 만족시키는 정수 $x$ 의 개수를 구하시오.", [], "4"],
  ["순열의 수", "서로 다른 5 권의 책 중에서 3 권을 골라 일렬로 꽂는 방법의 수는?", ["$20$", "$30$", "$60$", "$90$", "$120$"], "3"],
  ["인수분해", "$x^2-5x+6$ 을 인수분해하면 $(x-a)(x-b)$ 일 때, $a^2+b^2$ 의 값을 구하시오. (단, $a<b$)", [], "13"]];
function makeAnswer() {
  const out = [];
  if (nMake === 0) out.push({kind: "유사문제", title: "베낀 문제", statement: "함수 $y=-x(x-6)$ 의 그래프 ...", choices: [], figure_description: "", figure_svg: "", answer: "9", solution_steps: ["베낌"], shared_concepts: [], relation_to_original: "", unit_id: "CM1-2-2", difficulty: 4});
  for (let i = 0; i < 2; i++) {
    const [title, statement, choices, answer] = MAKE_POOL[(nMake * 2 + i) % MAKE_POOL.length];
    out.push({kind: "유사문제", title, statement, choices, figure_description: "", figure_svg: "", answer, solution_steps: ["계산한다."], shared_concepts: ["계산"], relation_to_original: "", reference_numbers: i === 0 ? [2] : [], unit_id: "CM1-1-1", difficulty: 4});
  }
  nMake++;
  return {problems: out};
}
function answerFor(prompt) {
  if (prompt.includes("연결 확인")) return {ok: true};
  if (prompt.includes("레이아웃을 읽는 도구")) return {columns: [{x0: 0, x1: 1000}], problems: [{number: 1, column: 0, y_top: 30}, {number: 2, column: 0, y_top: 520}], groups: [], column_bottoms: [990]};
  if (prompt.includes("검토자")) {
    const n = (prompt.match(/\[문제 \d+\]/g) || []).length;
    return {items: Array.from({length: n}, (_, i) => ({index: i + 1, answer: i === 1 ? "7" : "3", well_posed: true, issues: ""}))};
  }
  if (prompt.includes("[새 문제 만들기]")) { makePrompts.push(prompt); return makeAnswer(); }
  if (prompt.includes("출제 경험")) return {problems: [
    {kind: "유사문제", title: "넓이가 최대인 삼각형", statement: "이차함수 $y=-x(x-8)$ 의 그래프 위의 점 P 에 대하여 삼각형 OAP 의 넓이가 최대일 때, 점 P 의 $y$좌표는?",
      choices: ["$12$", "$14$", "$16$", "$18$", "$20$"], figure_description: "포물선과 x축의 두 교점 O, A, 포물선 위의 점 P",
      figure_svg: '<svg viewBox="0 0 400 300" onload="alert(1)"><script>alert(2)</script><line x1="20" y1="260" x2="380" y2="260" stroke="#000"/><path d="M40 260 Q200 -60 360 260" stroke="#000" fill="none" onclick="x()"/><text x="34" y="280">O</text><text x="356" y="280">A</text><image href="http://evil.example/x.png"/><circle cx="250" cy="120" r="4" fill="#000"/><text x="258" y="114">P</text></svg>', answer: "3",
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
    solution_approach: "밑변을 고정하고 높이 $y=-x(x-6)$ 을 이차함수로 나타내 꼭짓점에서 최댓값을 찾는다.", answer: "3",
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
      const docs = {}, subs = {};
      const col = c => { docs[c] = docs[c] || new Map(); subs[c] = subs[c] || []; return c; };
      const snap = c => ({docs: [...docs[c].entries()].map(([id, v]) => ({id, exists: true, data: () => JSON.parse(JSON.stringify(v)), metadata: {fromCache: false}})), metadata: {fromCache: false, hasPendingWrites: false}});
      const fire = c => setTimeout(() => subs[c].forEach(f => f(snap(c))), 5);
      const db = {collection: c => (col(c), {onSnapshot: n => { subs[c].push(n); fire(c); return () => {}; }, doc: id => ({set: async v => { docs[c].set(id, v); fire(c); }, delete: async () => { docs[c].delete(id); fire(c); }})})};
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
  // 풀이 줄 앞에 번호를 붙이지 않는다
  const stepMarks = await page.evaluate(() => [...document.querySelectorAll("#detail ol.steps li")].map(li => getComputedStyle(li, "::before").content).filter(c => c && c !== "none" && c !== "normal"));
  if (stepMarks.length) fails.push("풀이 줄 번호가 남아 있음: " + stepMarks);
  await page.locator("#detail [data-pick='3']").click(); await page.waitForTimeout(200);
  console.log("grade chip:", await page.locator("#detail .answer-card .chip.ok, #detail .answer-card .chip.bad").last().textContent());
  await page.screenshot({path: `${OUT}/${MODE}-3-answer.png`});
  await page.locator("#detail .seg button[data-t=analysis]").click(); await page.waitForTimeout(200);
  await page.screenshot({path: `${OUT}/${MODE}-4-analysis.png`});
  // 분석 탭에는 핵심 접근법이 없고, 내용이 길면 오른쪽 패널 전체가 스크롤된다 (칸마다 스크롤이 생기지 않음)
  const longView = await page.evaluate(() => {
    const p = state.problems.get(detailState.id), keep = p.classification.transcription;
    p.classification.transcription = "직선 $ED$ 위의 점 $F$, $G$ 의 위치를 비율로 나타낸다. ".repeat(60);
    renderDetail();
    const body = document.querySelector("#detail .seg-body"), m = body.querySelector(".math");
    const r = [/핵심 접근법/.test(body.textContent), body.scrollHeight > body.clientHeight, m.scrollHeight - m.clientHeight];
    p.classification.transcription = keep; renderDetail();
    return r;
  });
  console.log("analysis view:", JSON.stringify(longView));
  if (longView[0] || !longView[1] || longView[2] > 1) fails.push("분석 탭 표시: " + longView);
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
  // 만든 문제: 그림 정리(스크립트·이벤트·외부 그림 제거), 시험지 모양 이미지, 텍스트 복사
  const svgInfo = await page.evaluate(() => { const s = document.querySelector("#detail .gen .p-fig svg"); return s ? [s.querySelectorAll("line,path,circle,text").length, /script|onload|onclick|image|evil/.test(s.outerHTML)] : null; });
  console.log("gen svg:", JSON.stringify(svgInfo));
  if (!svgInfo || svgInfo[0] < 5 || svgInfo[1]) fails.push("만든 문제 그림 정리: " + JSON.stringify(svgInfo));
  await page.locator("#detail .gen .g-view button[data-v=image]").first().click();
  await page.waitForSelector("#detail .gen .gen-img", {timeout: 20000});
  const genImg = await page.evaluate(() => { const i = document.querySelector("#detail .gen .gen-img"); return [i.naturalWidth, i.naturalHeight]; });
  console.log("gen image:", JSON.stringify(genImg));
  if (!(genImg[0] >= 1200 && genImg[1] > 300)) fails.push("만든 문제 이미지: " + genImg);
  await page.screenshot({path: `${OUT}/${MODE}-5b-gen-image.png`});
  // 상세 창이 통째로 스크롤되어 머리(번호·닫기)가 밀려 올라가지 않아야 한다 (수식이 많은 풀이를 펼친 상태)
  await page.locator("#detail .gen .g-view button[data-v=text]").first().click();
  for (const s of await page.locator("#detail .gen details").all()) await s.evaluate(d => d.open = true);
  await page.waitForTimeout(300);
  const dlg = await page.evaluate(() => { const d = document.querySelector("#detail"); return [d.scrollHeight - d.clientHeight, d.querySelector(".d-head").getBoundingClientRect().top - d.getBoundingClientRect().top]; });
  console.log("dialog overflow:", JSON.stringify(dlg));
  if (dlg[0] > 2 || dlg[1] < 0) fails.push("상세 창이 통째로 스크롤됨: " + dlg);
  const pngData = await page.evaluate(() => document.querySelector("#detail .gen .gen-img").src.split(",")[1]);
  fs.writeFileSync(`${OUT}/${MODE}-gen-problem.png`, Buffer.from(pngData, "base64"));
  const txt = await page.evaluate(() => genText(state.problems.get(detailState.id).generated[0], 1));
  console.log("gen text:", JSON.stringify(txt.slice(0, 80)));
  if (!/^1\. 이차함수/.test(txt) || !/① \$12\$/.test(txt)) fails.push("만든 문제 텍스트");
  await page.click("#detail .next"); await page.waitForTimeout(200);
  console.log("next ->", (await page.textContent("#detail .crumb")).slice(-6));
  await page.click("#detail .close");

  // 문항 표
  await page.click("nav.tabs button[data-tab=table]");
  console.log("table rows:", await page.locator("#sheet tbody tr[data-id]").count());
  // 표 안 수식, 머리글 세 번 누르면 원래 순서
  const tableMath = await page.locator("#sheet tbody .katex").count();
  console.log("table math:", tableMath);
  if (!tableMath) fails.push("문항 표 수식");
  const rowOrder = () => page.evaluate(() => [...document.querySelectorAll("#sheet tbody tr[data-id]")].map(tr => tr.dataset.id).join());
  const orig = await rowOrder(), noTh = page.locator('#sheet th[data-k="num"]');
  await noTh.click(); const asc = await rowOrder(); const a1 = await noTh.getAttribute("aria-sort");
  await page.locator('#sheet th[data-k="num"]').click(); const desc = await rowOrder(); const a2 = await page.locator('#sheet th[data-k="num"]').getAttribute("aria-sort");
  const resetShown = await page.locator("#t-sort-reset").isVisible();
  await page.locator('#sheet th[data-k="num"]').click(); const back = await rowOrder(); const a3 = await page.locator('#sheet th[data-k="num"]').getAttribute("aria-sort");
  console.log("sort cycle:", a1, a2, a3, "reset button:", resetShown, "restored:", back === orig, "desc is reverse:", desc === asc.split(",").reverse().join());
  if (a1 !== "ascending" || a2 !== "descending" || a3 !== "none" || back !== orig || !resetShown || desc !== asc.split(",").reverse().join()) fails.push("표 정렬 되돌리기");
  await page.locator('#sheet th[data-k="num"]').click(); await page.click("#t-sort-reset");
  if (await rowOrder() !== orig || await page.locator("#t-sort-reset").isVisible()) fails.push("정렬 원래대로 버튼");
  await page.screenshot({path: `${OUT}/${MODE}-6-table.png`});
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
  // 직접 옮긴 단원은 다시 분류해도 유지
  await page.evaluate(id => classifyMany([id]), dragId);
  await page.click("nav.tabs button[data-tab=table]");
  // 문항 표에는 한꺼번에 작업(분류·풀이·옮기기·만들기)과 선택 칸이 없다
  const noBulk = await page.evaluate(() => ["#t-classify", "#t-solve", "#t-move", "#t-gen", "#t-all", "#sheet .sel"].filter(x => document.querySelector(x)));
  console.log("table bulk controls left:", JSON.stringify(noBulk), "|", await page.textContent("#t-sel"));
  if (noBulk.length) fails.push("문항 표 한꺼번에 작업 남음: " + noBulk);
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

  // ④ 문제 만들기: 단원 범위(공통수학1 전체)·난이도·유형·개수 → 문제 저장소와 따로 '만든 문제 보관함'에
  const libBefore = await page.evaluate(() => [state.problems.size, state.exams.size]);
  await page.click("nav.tabs button[data-tab=make]");
  await page.selectOption("#mk-unit .up-subj", "CM1");
  await page.selectOption("#mk-diff", "4"); await page.selectOption("#mk-type", "5지선다");
  await page.fill("#mk-count", "3");
  await page.click("#mk-go");
  await page.waitForFunction(() => /저장했습니다|실패/.test(document.querySelector("#mk-status").textContent), null, {timeout: 60000});
  await page.waitForTimeout(300);
  const mk = await page.evaluate(() => {
    const ms = [...state.made.values()];
    return {status: document.querySelector("#mk-status").textContent, made: ms.length, units: ms.map(m => m.g.unit_id), diffs: ms.map(m => m.g.difficulty),
      lib: [state.problems.size, state.exams.size], fresh: document.querySelectorAll("#mk-results .gen.fresh").length};
  });
  console.log("make:", JSON.stringify(mk));
  const mp = makePrompts[0] || "";
  console.log("make prompt:", JSON.stringify({refs: mp.includes("[참고 문항]"), profile: (mp.match(/\[저장된 문항의 형식\][^\n]*/) || [""])[0].slice(0, 140), noCopy: mp.includes("그대로 옮기거나")}));
  if (!mp.includes("[참고 문항]") || !mp.includes("[저장된 문항의 형식]") || !mp.includes("그대로 옮기거나")) fails.push("문제 만들기: 저장된 문항 형식 참고");
  if (!/버린 문제 1개/.test(mk.status)) fails.push("문제 만들기: 저장된 문항과 같은 문제 버리기 " + mk.status);
  if (makePrompts.length > 1 && !makePrompts[1].includes("베낀 문제")) fails.push("문제 만들기: 버린 문제를 다음 요청에 알림");
  if (mk.made !== 3 || !mk.units.every(u => /^CM1-/.test(u)) || !mk.diffs.every(x => x === 4) || mk.lib.join() !== libBefore.join() || mk.fresh !== 3)
    fails.push("문제 만들기 → 보관함 (저장소와 따로): " + JSON.stringify(mk));
  // 참고한 문항: AI 가 고른 번호(2번 참고 문항) 또는 함께 보낸 참고 문항 전체, 칩을 누르면 그 문항 상세
  const refs = await page.evaluate(() => [...state.made.values()].map(m => [m.g.referencesGuessed, (m.g.references || []).map(r => r.label).join("|"), (m.g.references || []).every(r => state.problems.has(r.id))]));
  console.log("references:", JSON.stringify(refs));
  if (!refs.some(r => r[0] === false && r[1].split("|").length === 1) || !refs.some(r => r[0] === true && r[1].split("|").length >= 2) || !refs.every(r => r[2] && /번/.test(r[1])))
    fails.push("참고한 문항 기록: " + JSON.stringify(refs));
  const chip = page.locator("#mk-results .gen.fresh .refs .ref-open").first();
  const chipText = await chip.textContent();
  await chip.click(); await page.waitForTimeout(300);
  const opened = await page.evaluate(() => document.querySelector("#detail").open && document.querySelector("#detail .d-head").textContent.replace(/\s+/g, " "));
  console.log("reference chip:", chipText, "->", (opened || "").slice(0, 60));
  if (!opened || !opened.includes(chipText.replace(/.* (\d+)번$/, "$1"))) fails.push("참고 문항 칩 열기");
  await page.click("#detail .close");
  // 이미지 저장을 누르면 저장되는 이미지가 그 카드에 보인다
  const card2 = page.locator("#mk-results .gen").nth(1);
  const savedBefore = MODE === "html" ? 0 : await page.evaluate(() => window.__saved.length);
  const dl = MODE === "html" ? page.waitForEvent("download", {timeout: 15000}) : null;
  await card2.locator(".g-save-img").click();
  if (dl) await dl; else await page.waitForFunction(n => window.__saved.length > n, savedBefore, {timeout: 15000});
  await page.waitForTimeout(200);
  const shownImg = await card2.evaluate(c => [!c.querySelector(".g-image").hidden, c.querySelector(".g-text").hidden, !!c.querySelector(".g-image img.gen-img")?.naturalWidth,
    c.querySelector('.g-view button[data-v="image"]').getAttribute("aria-pressed")]);
  console.log("save image shows image:", JSON.stringify(shownImg));
  if (shownImg.join() !== "true,true,true,true") fails.push("이미지 저장 때 이미지 보이기: " + shownImg);
  await page.screenshot({path: `${OUT}/${MODE}-11-make.png`, fullPage: true});
  // 참고 문항 선정 규칙: 대단원 범위, 최신 위주, 한 출처에 몰리지 않음(제한 없음), 유형 우선
  const algo = await page.evaluate(() => {
    const keep = [state.problems, state.exams];
    const ex = (id, title, addedAt) => ({id, title, kind: "pdf", addedAt});
    const P = (id, examId, unitId, type, score, number) => ({id, examId, examTitle: examId, number, order: number, unitId,
      classification: {transcription: id + " 문제", question_type: type, difficulty_score: score}});
    const run = (exams, probs, scope, diff, type) => {
      state.exams = new Map(exams.map(e => [e.id, e])); state.problems = new Map(probs.map(p => [p.id, p])); state.rev++;
      const r = styleRefs(scope, diff, type); return {where: r.where, ids: r.picked.map(p => p.id)};
    };
    const out = {};
    try {
      // ① 고른 중단원(ALG-1-2)에 문항이 없으면 같은 대단원(ALG-1-*)에서, 다른 대단원(ALG-2-*)은 쓰지 않음
      out.chapter = run([ex("e1", "2024 고2 3월", "2026-01-01")],
        [P("a1", "e1", "ALG-1-1", "5지선다", 6, 1), P("a2", "e1", "ALG-2-1", "5지선다", 6, 2)], {ids: ["ALG-1-2"]}, "3", "auto");
      // ② 최신 위주: 같은 조건이면 2024 년 출처가 2015 년보다 먼저
      const old = ex("old", "2015 고1 3월", "2026-11-01"), neu = ex("new", "2024 고1 3월", "2026-01-01");
      out.recent = run([old, neu], [P("o1", "old", "CM1-1-1", "5지선다", 6, 1), P("n1", "new", "CM1-1-1", "5지선다", 6, 1)], {ids: ["CM1-1-1"]}, "3", "auto");
      // ③ 한 출처에 몰리지 않음: 최신 출처 A 에 6문항, B 에 2문항이면 B 도 뽑힘 / 출처가 하나뿐이면 그 출처에서 4개 모두
      const A = ex("A", "2024 고1 6월", ""), B = ex("B", "2023 고1 6월", "");
      const many = [1, 2, 3, 4, 5, 6].map(k => P("A" + k, "A", "CM1-1-1", "5지선다", 6, k)).concat([P("B1", "B", "CM1-1-1", "5지선다", 6, 1), P("B2", "B", "CM1-1-1", "5지선다", 6, 2)]);
      out.spread = run([A, B], many, {ids: ["CM1-1-1"]}, "3", "auto");
      out.single = run([A], many.filter(p => p.examId === "A"), {ids: ["CM1-1-1"]}, "3", "auto");
      // ④ 유형 우선: 단답형을 고르면 단답형이 먼저
      out.type = run([A], [P("m1", "A", "CM1-1-1", "5지선다", 6, 1), P("m2", "A", "CM1-1-1", "5지선다", 6, 2), P("s1", "A", "CM1-1-1", "단답형", 6, 3)], {ids: ["CM1-1-1"]}, "3", "단답형");
      // ⑤ 같은 조건이면 매번 순서가 바뀔 수 있음 (무작위)
      const seen = new Set();
      for (let k = 0; k < 30; k++) seen.add(run([A], many.filter(p => p.examId === "A"), {ids: ["CM1-1-1"]}, "3", "auto").ids.join());
      out.varies = seen.size;
    } finally { [state.problems, state.exams] = keep; state.rev++; }
    return out;
  });
  console.log("reference algorithm:", JSON.stringify(algo));
  const srcCount = (ids, src) => ids.filter(x => x.startsWith(src)).length;
  if (algo.chapter.where !== "같은 대단원" || algo.chapter.ids.join() !== "a1") fails.push("참고 문항: 대단원 범위 " + JSON.stringify(algo.chapter));
  if (algo.recent.ids[0] !== "n1") fails.push("참고 문항: 최신 위주 " + JSON.stringify(algo.recent));
  if (algo.spread.ids.length !== 4 || srcCount(algo.spread.ids, "B") < 1 || srcCount(algo.spread.ids, "A") < 2) fails.push("참고 문항: 출처 고르게 " + JSON.stringify(algo.spread));
  if (algo.single.ids.length !== 4) fails.push("참고 문항: 출처 하나면 제한 없이 " + JSON.stringify(algo.single));
  if (algo.type.ids[0] !== "s1") fails.push("참고 문항: 유형 우선 " + JSON.stringify(algo.type));
  if (algo.varies < 2) fails.push("참고 문항: 동점 무작위 " + algo.varies);

  // ⑤ AI 생성 문제: 원본 문항에서 만든 문제도 함께 보이고, 단원 트리·거르기·삭제가 된다
  await page.click("nav.tabs button[data-tab=ai]"); await page.waitForTimeout(200);
  const box = await page.evaluate(() => [madeEntries().length, madeEntries().filter(e => e.from === "derived").length]);
  const treeAll = (await page.textContent('#mb-tree .node[data-k=""] .n')).trim();
  await page.click('#mb-tree .node[data-k="CM1"]'); await page.waitForTimeout(300);
  const cm1View = await page.evaluate(() => [document.querySelectorAll("#mb-results .gen").length, madeEntries().filter(e => /^CM1-/.test(e.g.unit_id)).length,
    document.querySelector('#mb-tree .node[data-k="CM1"]').getAttribute("aria-expanded"), document.querySelector("#mb-status").textContent]);
  await page.click('#mb-tree .node[data-k="CM1-1"]'); await page.click('#mb-tree .node[data-k="CM1-1-1"]'); await page.waitForTimeout(300);
  const sec = await page.evaluate(() => [document.querySelectorAll("#mb-results .gen").length, madeEntries().filter(e => e.g.unit_id === "CM1-1-1").length, document.querySelector("#mb-status").textContent]);
  await page.screenshot({path: `${OUT}/${MODE}-12-ai-tab.png`});
  await page.click('#mb-tree .node[data-k="CM1"]'); // 다시 누르면 접힘
  const folded = await page.getAttribute('#mb-tree .node[data-k="CM1"]', "aria-expanded");
  await page.click('#mb-tree .node[data-k=""]'); await page.waitForTimeout(200);
  console.log("ai tab tree:", treeAll, JSON.stringify(cm1View), JSON.stringify(sec), "folded:", folded);
  if (+treeAll !== box[0] || cm1View[0] !== cm1View[1] || cm1View[2] !== "true" || !/^공통수학1 · /.test(cm1View[3]) || sec[0] !== sec[1] || !sec[0] || !/이차방정식|다항식의 연산/.test(sec[2]) || folded !== "false")
    fails.push("AI 생성 문제 단원 트리: " + JSON.stringify([treeAll, cm1View, sec, folded]));
  await page.selectOption("#mb-from", "make"); await page.waitForTimeout(200);
  const onlyMake = await page.locator("#mb-results .gen").count();
  await page.locator("#mb-results .gen .g-del").first().click(); await page.click("#confirm-yes"); await page.waitForTimeout(400);
  const afterBoxDel = await page.evaluate(() => state.made.size);
  await page.selectOption("#mb-from", "");
  // 원본 문항에서 만든 문제도 보관함에서 지워진다 (하나, 그리고 보이는 문제 한꺼번에)
  await page.selectOption("#mb-from", "derived"); await page.waitForTimeout(200);
  const derivedBefore = await page.evaluate(() => [...state.problems.values()].reduce((n, p) => n + (p.generated?.length || 0), 0));
  await page.locator("#mb-results .gen .g-del").first().click(); await page.click("#confirm-yes"); await page.waitForTimeout(400);
  const derivedOne = await page.evaluate(() => [...state.problems.values()].reduce((n, p) => n + (p.generated?.length || 0), 0));
  const cardsLeft = await page.locator("#mb-results .gen").count();
  await page.click("#mb-del-shown"); await page.click("#confirm-yes"); await page.waitForTimeout(600);
  const derivedAll = await page.evaluate(() => [...state.problems.values()].reduce((n, p) => n + (p.generated?.length || 0), 0));
  console.log("delete derived:", derivedBefore, "->", derivedOne, "cards", cardsLeft, "-> all", derivedAll);
  if (derivedOne !== derivedBefore - 1 || cardsLeft !== derivedBefore - 1 || derivedAll !== 0) fails.push("보관함에서 원본 문항의 만든 문제 삭제");
  await page.selectOption("#mb-from", "");
  console.log("box:", JSON.stringify(box), "only make:", onlyMake, "after delete:", afterBoxDel);
  if (box[1] < 1 || box[0] !== 3 + box[1] || onlyMake !== 3 || afterBoxDel !== 2) fails.push("만든 문제 보관함");
  // 예전 버전이 문제 저장소에 넣은 '만든 문제' 출처는 보관함으로 옮겨진다
  const legacy = await page.evaluate(async () => {
    await PLATFORM.store.putExam({id: "eLEGACY", title: "AI 생성 문제", kind: "generated", addedAt: "2026-11-22T00:00:00Z"});
    await PLATFORM.store.putProblem({id: "eLEGACY-q01", examId: "eLEGACY", examTitle: "AI 생성 문제", order: 1, number: 1, section: 0, image: "", unitId: "CM1-1-1",
      classification: {transcription: "1. 예전에 만든 문제입니다. $1+1$ 의 값은?", answer: "2", solution_steps: ["더한다."], difficulty_score: 4}, generated: []});
    const n = await migrateLegacyMade();
    return [n, state.exams.has("eLEGACY"), state.problems.has("eLEGACY-q01"), [...state.made.values()].some(m => /예전에 만든 문제/.test(m.g.statement))];
  });
  console.log("legacy move:", JSON.stringify(legacy));
  if (legacy.join() !== "1,false,false,true") fails.push("예전 만든 문제 옮기기: " + legacy);
  if (MODE === "html") {
    await page.reload(); await page.waitForTimeout(800);
    const kept = await page.evaluate(() => state.made.size);
    console.log("box after reload:", kept);
    if (kept !== 3) fails.push("보관함 저장 유지: " + kept);
  }
  // 문제 저장소에서 삭제: 카드 ✕(확인 창) → 보이는 문항 삭제 → 출처 삭제 (이미지로 넣은 출처로 확인)
  await page.click("nav.tabs button[data-tab=library]");
  const delEx = await page.evaluate(() => [...state.exams.values()].find(e => /^이미지 2장/.test(e.title)).id);
  await page.selectOption("#f-exam", delEx); await page.waitForTimeout(300);
  const cnt = () => page.evaluate(id => [...state.problems.values()].filter(p => p.examId === id).length, delEx);
  const before3 = await cnt();
  await page.locator("#grid .card .x").first().click(); await page.click("#confirm-yes"); await page.waitForTimeout(400);
  const afterOne = await cnt();
  await page.click("#btn-del-shown"); await page.click("#confirm-yes"); await page.waitForTimeout(400);
  const afterShown = await cnt();
  const delExamShown = await page.locator("#btn-del-exam").isVisible();
  await page.click("#btn-del-exam"); await page.click("#confirm-yes"); await page.waitForTimeout(400);
  const examGone = await page.evaluate(id => !state.exams.has(id), delEx);
  console.log("delete:", before3, afterOne, afterShown, delExamShown, examGone);
  if (afterOne !== before3 - 1 || afterShown !== 0 || !delExamShown || !examGone) fails.push("저장소 삭제");

  // 화면마다 새로고침 = 다시 조회 (저장소에서 새로 받아 오고 검색·거르기·정렬·선택을 처음 상태로)
  if (MODE === "html") {
    await page.click("nav.tabs button[data-tab=library]"); await page.waitForTimeout(200);
    await page.evaluate(() => new Promise((res, rej) => { // 다른 창에서 저장한 것처럼 IndexedDB 에 직접 넣는다
      const r = indexedDB.open("mathgen", 2);
      r.onsuccess = () => { const tx = r.result.transaction("problems", "readwrite");
        tx.objectStore("problems").put({id: "outside-q1", examId: "outside", examTitle: "바깥에서", order: 1, number: 1, section: 0, image: "", classification: null, unitId: null, generated: []});
        tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
      r.onerror = () => rej(r.error);
    }));
  }
  await page.click("nav.tabs button[data-tab=library]");
  await page.fill("#q", "없는검색어"); await page.dispatchEvent("#q", "input");
  await page.evaluate(() => { state.open.add("CM1"); state.filter.unit = "CM1"; renderGrid(); });
  const libBeforeQ = await page.evaluate(() => [state.problems.has("outside-q1"), document.querySelector("#lib-status").textContent]);
  await page.click("#tab-library .page-refresh"); await page.waitForFunction(() => /다시 조회했습니다/.test(document.querySelector("#tab-library .page-stamp").textContent));
  const libAfterQ = await page.evaluate(() => [state.problems.has("outside-q1"), document.querySelector("#q").value, state.filter.unit, state.open.size, document.querySelector("#lib-status").textContent]);
  console.log("requery library:", JSON.stringify(libBeforeQ), "->", JSON.stringify(libAfterQ));
  if (libAfterQ[1] !== "" || libAfterQ[2] !== null || libAfterQ[3] !== 0 || !/^전체/.test(libAfterQ[4]) || (MODE === "html" && (libBeforeQ[0] || !libAfterQ[0]))) fails.push("저장소 다시 조회");
  if (MODE === "html") await page.evaluate(() => removeProblem(state.problems.get("outside-q1")));
  // 문항 표: 정렬·선택·검색이 처음 상태로
  await page.click("nav.tabs button[data-tab=table]");
  await page.click('#sheet th[data-k="num"]'); await page.fill("#t-q", "group"); await page.dispatchEvent("#t-q", "input");
  await page.click("#tab-table .page-refresh"); await page.waitForFunction(() => /다시 조회했습니다/.test(document.querySelector("#tab-table .page-stamp").textContent));
  const tblQ = await page.evaluate(() => [state.sort.key, 0, document.querySelector("#t-q").value]);
  console.log("requery table:", JSON.stringify(tblQ));
  if (tblQ.join("|") !== "|0|") fails.push("문항 표 다시 조회: " + tblQ);
  // 설정: 저장하지 않은 입력은 버리고 저장된 값으로 (다운로드 버전)
  if (MODE === "html") {
    await page.click("nav.tabs button[data-tab=settings]");
    await page.selectOption("#s-provider", "anthropic"); await page.fill("#s-key", "sk-ant-test"); await page.click("#s-save"); // 이 창에서만 쓰는 키로 연결
    const saved = await page.inputValue("#s-provider"); const aiBefore = await page.evaluate(() => aiOK());
    await page.selectOption("#s-provider", saved === "openai" ? "gemini" : "openai");
    await page.click("#tab-settings .page-refresh"); await page.waitForFunction(() => /다시 조회했습니다/.test(document.querySelector("#tab-settings .page-stamp").textContent));
    const back = await page.inputValue("#s-provider");
    console.log("requery settings:", saved, "->", back);
    if (back !== saved) fails.push("설정 다시 조회");
    const aiStill = await page.evaluate(() => aiOK());
    console.log("ai before/after settings requery:", aiBefore, aiStill);
    if (!aiBefore || !aiStill) fails.push("설정 다시 조회 뒤 AI 연결 유지");
  }
  const stamps = [];
  for (const tab of ["ingest", "library", "table", "make", "ai", "settings"]) {
    await page.click(`nav.tabs button[data-tab=${tab}]`);
    await page.click(`#tab-${tab} .page-refresh`);
    await page.waitForFunction(id => /다시 조회했습니다/.test(document.querySelector(`#tab-${id} .page-stamp`).textContent), tab, {timeout: 12000}).catch(() => {});
    stamps.push(/다시 조회했습니다/.test(await page.textContent(`#tab-${tab} .page-stamp`)));
  }
  const jobsLeft = await page.evaluate(() => [document.querySelectorAll("#jobs > .panel").length, document.querySelector("#ingest-empty").hidden]);
  console.log("refresh buttons:", JSON.stringify(stamps), "ingest jobs after:", JSON.stringify(jobsLeft));
  if (!stamps.every(Boolean)) fails.push("화면별 새로고침: " + stamps);
  if (jobsLeft[0] !== 0 || jobsLeft[1]) fails.push("넣기 화면 다시 조회: " + jobsLeft);

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
