#!/usr/bin/env python3
"""src/ 의 공통 코드로 두 가지 결과물을 만든다.

    python tools/build.py
        → mathgen.html  (다운로드해서 쓰는 단일 HTML. API 키로 Claude·OpenAI·Gemini 호출)

    python tools/build.py --artifact OUT_DIR --katex KATEX_PKG --pdfjs PDFJS_PKG
        → OUT_DIR/mathgen-artifact.html, OUT_DIR/pdf.worker.min.js, OUT_DIR/cmaps.json
          (claude.ai 아티팩트로 게시할 페이지와 함께 올릴 파일)
          KATEX_PKG: npm katex@0.16.11 패키지 폴더, PDFJS_PKG: npm pdfjs-dist@3.11.174 패키지 폴더
          (npm pack katex@0.16.11 pdfjs-dist@3.11.174 로 받아 풀면 된다)

공통 코드: src/app.css, src/app.body.html, src/app.js
플랫폼 부분: src/platform.standalone.js, src/platform.artifact.js
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
TITLE = "모의고사 문제 도우미"
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500'
         '&family=IBM+Plex+Sans+KR:wght@400;600&family=Nanum+Myeongjo:wght@700;800&display=swap">')
LIBS = """<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>"""
BANNER = "<!-- 이 파일은 tools/build.py 가 src/ 로부터 만든 결과물입니다. 고칠 때는 src/ 를 고친 뒤 다시 빌드하세요. -->"


def read(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8")


def script(platform: str) -> str:
    return f"<script>\n{read(platform)}\n{read('app.js')}\n</script>"


def build_standalone(out: Path) -> None:
    html = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{TITLE}</title>
{BANNER}
{FONTS}
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>
{read('app.css')}
</style>
{LIBS}
</head>
<body>
{read('app.body.html')}
{script('platform.standalone.js')}
</body>
</html>
"""
    out.write_text(html, encoding="utf-8")
    print(f"만듦: {out} ({len(html):,}자)")


def inline_katex_css(katex: Path) -> str:
    css = (katex / "dist" / "katex.min.css").read_text(encoding="utf-8")

    def rep(m: re.Match) -> str:
        data = base64.b64encode((katex / "dist" / "fonts" / f"{m.group(1)}.woff2").read_bytes()).decode()
        return f'src:url(data:font/woff2;base64,{data}) format("woff2")'

    css = re.sub(r'src:url\(fonts/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\(fonts/[\w-]+\.woff\) format\("woff"\))?'
                 r'(?:,url\(fonts/[\w-]+\.ttf\) format\("truetype"\))?', rep, css)
    assert "url(fonts/" not in css, "KaTeX 글꼴을 모두 넣지 못했습니다"
    return css


def build_artifact(out_dir: Path, katex: Path, pdfjs: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    # 아티팩트는 게시할 때 <html><head><body> 뼈대가 씌워지므로 내용만 쓴다
    html = f"""<title>{TITLE}</title>
<meta name="claude:viewport-fit-sides" content="cover">
{BANNER}
{FONTS}
<style>
{inline_katex_css(katex)}
</style>
<style>
{read('app.css')}
</style>
{read('app.body.html')}
{LIBS}
{script('platform.artifact.js')}
"""
    (out_dir / "mathgen-artifact.html").write_text(html, encoding="utf-8")
    shutil.copy2(pdfjs / "build" / "pdf.worker.min.js", out_dir / "pdf.worker.min.js")
    cmaps = {f.stem: base64.b64encode(f.read_bytes()).decode()
             for f in sorted((pdfjs / "cmaps").glob("*.bcmap"))
             if re.match(r"(Adobe-Korea1|KSC|UniKS)", f.name)}
    (out_dir / "cmaps.json").write_text(json.dumps(cmaps), encoding="utf-8")
    print(f"만듦: {out_dir}/mathgen-artifact.html ({len(html):,}자), pdf.worker.min.js, cmaps.json ({len(cmaps)}개)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "mathgen.html"), help="다운로드 버전 결과 파일")
    ap.add_argument("--artifact", help="아티팩트 버전을 만들 폴더")
    ap.add_argument("--katex", help="katex 패키지 폴더 (아티팩트용)")
    ap.add_argument("--pdfjs", help="pdfjs-dist 패키지 폴더 (아티팩트용)")
    args = ap.parse_args()
    build_standalone(Path(args.out))
    if args.artifact:
        if not (args.katex and args.pdfjs):
            ap.error("--artifact 에는 --katex 와 --pdfjs 가 필요합니다")
        build_artifact(Path(args.artifact), Path(args.katex), Path(args.pdfjs))


if __name__ == "__main__":
    main()
