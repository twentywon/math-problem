#!/usr/bin/env node
// mathgen.html 로 claude.ai 아티팩트 버전을 만든다 (Node 만 있으면 됨, 설치할 패키지 없음).
//
//   node tools/build-artifact.js <출력 폴더> <katex 패키지 폴더> <pdfjs-dist 패키지 폴더>
//
// 결과: <출력 폴더>/mathgen-artifact.html, pdf.worker.min.js, cmaps.json (셋 다 함께 게시)
// 패키지 폴더는 npm pack katex@0.16.11 pdfjs-dist@3.11.174 로 받아 tar -xzf 로 푼 package/ 폴더.
//
// 바뀌는 것:
// - mathgen.html 의 [PLATFORM 시작]~[PLATFORM 끝] 부분 → artifact/platform.js
//   (AI 는 페이지를 여는 사람의 Claude 계정, 저장은 아티팩트 저장소, 파일 저장은 downloads 기능)
// - KaTeX CSS 를 글꼴까지 페이지 안에 넣는다 (아티팩트는 외부 스타일시트를 Google Fonts 만 허용)
// - <html><head><body> 뼈대는 게시할 때 씌워지므로 내용만 쓴다
// 나머지(화면, 자르기, 분류·풀이, 난이도, 생성, 표, 내보내기)는 mathgen.html 과 똑같다.
"use strict";
const fs = require("fs");
const path = require("path");

const [OUT, KATEX, PDFJS] = process.argv.slice(2);
if (!OUT || !KATEX || !PDFJS) {
  console.error("사용법: node tools/build-artifact.js <출력 폴더> <katex 패키지 폴더> <pdfjs-dist 패키지 폴더>");
  process.exit(2);
}
const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "mathgen.html"), "utf8");
const platform = fs.readFileSync(path.join(ROOT, "artifact", "platform.js"), "utf8");

// 앞에서부터 차례로 찾는다. 끝 쪽(</body>, </script>)은 마지막 것을 쓴다
// (코드 안의 인쇄용 HTML 문자열에도 </head>, </body> 같은 글자가 들어 있다)
function at(s, mark, from = 0, last = false) {
  const i = last ? s.lastIndexOf(mark) : s.indexOf(mark, from);
  if (i < from || i < 0) throw new Error(`mathgen.html 에서 ${JSON.stringify(mark)} 를 찾지 못했습니다`);
  return i;
}
const t0 = at(html, "<title>") + 7, t1 = at(html, "</title>", t0);
const title = html.slice(t0, t1);
const head = html.slice(t1, at(html, "\n</head>\n", t1));
const fonts = head.match(/<link [^>]*fonts\.googleapis\.com[^>]*>/g).join("\n");
const s0 = at(head, "\n<style>\n") + 9, style = head.slice(s0, at(head, "\n</style>\n", s0));
const libs = head.match(/<script src="[^"]+"><\/script>/g).join("\n");
const b0 = at(html, "\n<body>\n") + 8;
const k0 = at(html, "\n<script>\n", b0);
const markup = html.slice(b0, k0);
const script = html.slice(k0 + 10, at(html, "\n</script>\n", k0, true));
const P1 = at(script, "/* [PLATFORM 끝] */");
at(script, "/* [PLATFORM 시작]");
const app = script.slice(P1 + "/* [PLATFORM 끝] */".length);

// KaTeX CSS: woff2 글꼴을 data URL 로 넣고 woff/ttf 대체 경로는 뺀다
const kdir = path.join(KATEX, "dist");
let katexCss = fs.readFileSync(path.join(kdir, "katex.min.css"), "utf8").replace(
  /src:url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\(fonts\/[\w-]+\.woff\) format\("woff"\))?(?:,url\(fonts\/[\w-]+\.ttf\) format\("truetype"\))?/g,
  (_, f) => `src:url(data:font/woff2;base64,${fs.readFileSync(path.join(kdir, "fonts", f + ".woff2")).toString("base64")}) format("woff2")`);
if (katexCss.includes("url(fonts/")) throw new Error("KaTeX 글꼴을 모두 넣지 못했습니다");

const banner = "<!-- 이 파일은 tools/build-artifact.js 가 mathgen.html 과 artifact/platform.js 로 만든 결과물입니다. 직접 고치지 마세요. -->";
const out = `<title>${title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
${banner}
${fonts}
<style>
${katexCss}
</style>
<style>
${style.trim()}
</style>
${markup.trim()}
${libs}
<script>
${platform.trim()}
${app.trim()}
</script>
`;

fs.mkdirSync(OUT, {recursive: true});
fs.writeFileSync(path.join(OUT, "mathgen-artifact.html"), out);
fs.copyFileSync(path.join(PDFJS, "build", "pdf.worker.min.js"), path.join(OUT, "pdf.worker.min.js"));
// 한글 CID 글꼴 매핑만 골라 하나의 JSON 으로 (아티팩트에는 .bcmap 을 올릴 수 없다)
const cdir = path.join(PDFJS, "cmaps"), cmaps = {};
for (const f of fs.readdirSync(cdir).sort())
  if (/^(Adobe-Korea1|KSC|UniKS).*\.bcmap$/.test(f)) cmaps[f.slice(0, -6)] = fs.readFileSync(path.join(cdir, f)).toString("base64");
fs.writeFileSync(path.join(OUT, "cmaps.json"), JSON.stringify(cmaps));
console.log(`만듦: ${OUT}/mathgen-artifact.html (${out.length.toLocaleString()}자), pdf.worker.min.js, cmaps.json (${Object.keys(cmaps).length}개)`);
