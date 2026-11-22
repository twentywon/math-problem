"""문제 저장소(library/) 관리.

library/
├── index.json                       모든 문제의 메타데이터 (분류 결과 포함)
├── index.html                       단원별로 문제를 훑어보는 페이지
├── exams/<시험ID>/                  시험지별 원본 자르기 결과
│   ├── source.pdf
│   ├── q01.png, q02.png, ...
│   └── _check/page_01.png ...       자른 영역을 표시한 검수용 이미지
├── units/<과목>/<대단원>/<중단원>/   2022 개정 단원별로 분류된 문제 이미지
│   └── <시험ID>_q01.png
└── generated/<문제ID>/              생성한 유사·연계 문제
    ├── generated.json
    ├── generated.md
    └── generated.html
"""

from __future__ import annotations

import html
import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from .curriculum import UNITS, get_unit

_SAFE_RE = re.compile(r"[^\w가-힣.\-]+")


def safe_name(s: str) -> str:
    return _SAFE_RE.sub("_", s).strip("_") or "exam"


class Library:
    def __init__(self, root: str | Path = "library"):
        self.root = Path(root)
        self.index_path = self.root / "index.json"

    # ------------------------------------------------------------ index
    def load(self) -> dict[str, Any]:
        if self.index_path.exists():
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        return {"exams": {}, "problems": {}}

    def save(self, index: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.index_path)

    def exam_dir(self, exam_id: str) -> Path:
        return self.root / "exams" / exam_id

    def problem_image(self, meta: dict[str, Any]) -> Path:
        return self.root / meta["image"]

    # ------------------------------------------------------------ 시험 등록
    def add_exam(self, exam_id: str, title: str, source_pdf: Path, crops: list[Any]) -> list[str]:
        index = self.load()
        exam_dir = self.exam_dir(exam_id)
        exam_dir.mkdir(parents=True, exist_ok=True)
        if source_pdf.resolve() != (exam_dir / "source.pdf").resolve():
            shutil.copy2(source_pdf, exam_dir / "source.pdf")
        # 다시 자른 경우 예전 문제 기록을 지운다
        for pid in [p for p, m in index["problems"].items() if m["exam_id"] == exam_id]:
            self._remove_unit_copy(index["problems"][pid])
            del index["problems"][pid]
        pids = []
        for c in crops:
            pid = f"{exam_id}_q{c.order:02d}"
            index["problems"][pid] = {
                "id": pid,
                "exam_id": exam_id,
                "exam_title": title,
                "order": c.order,
                "number": c.number,
                "section": c.section,
                "page": c.page + 1,
                "image": f"exams/{exam_id}/{c.image}",
                "shared": c.shared or None,
                "classification": None,
                "unit_id": None,
                "unit_image": None,
            }
            pids.append(pid)
        index["exams"][exam_id] = {
            "title": title,
            "source": f"exams/{exam_id}/source.pdf",
            "problem_count": len(crops),
            "added_at": datetime.now().isoformat(timespec="seconds"),
        }
        self.save(index)
        return pids

    # ------------------------------------------------------------ 분류 결과 저장
    def _remove_unit_copy(self, meta: dict[str, Any]) -> None:
        if meta.get("unit_image"):
            p = self.root / meta["unit_image"]
            if p.exists():
                p.unlink()

    def set_classification(self, pid: str, classification: dict[str, Any]) -> dict[str, Any]:
        index = self.load()
        meta = index["problems"][pid]
        self._remove_unit_copy(meta)
        unit = get_unit(classification["primary_unit_id"])
        unit_dir = self.root / "units" / Path(*unit.path_parts)
        unit_dir.mkdir(parents=True, exist_ok=True)
        dest = unit_dir / f"{pid}.png"
        shutil.copy2(self.problem_image(meta), dest)
        meta["classification"] = classification
        meta["unit_id"] = unit.unit_id
        meta["unit_image"] = dest.relative_to(self.root).as_posix()
        self.save(index)
        return meta

    # ------------------------------------------------------------ 생성 문제 저장
    def save_generated(self, pid: str, problems: list[dict[str, Any]]) -> Path:
        index = self.load()
        meta = index["problems"][pid]
        out = self.root / "generated" / pid
        out.mkdir(parents=True, exist_ok=True)
        # 여러 번 생성하면 이어 붙인다
        path = out / "generated.json"
        existing = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        stamp = datetime.now().isoformat(timespec="seconds")
        for p in problems:
            p.setdefault("created_at", stamp)
        all_problems = existing + problems
        path.write_text(json.dumps(all_problems, ensure_ascii=False, indent=2), encoding="utf-8")
        (out / "generated.md").write_text(render_markdown(meta, all_problems), encoding="utf-8")
        (out / "generated.html").write_text(render_html(meta, all_problems, image_rel=f"../../{meta['image']}"), encoding="utf-8")
        meta["generated_count"] = len(all_problems)
        self.save(index)
        return out

    # ------------------------------------------------------------ 둘러보기 페이지
    def build_index_html(self) -> Path:
        index = self.load()
        by_unit: dict[str, list[dict[str, Any]]] = {}
        for m in index["problems"].values():
            by_unit.setdefault(m.get("unit_id") or "_", []).append(m)
        parts = [_HTML_HEAD.format(title="문제 저장소")]
        parts.append("<h1>문제 저장소 (2022 개정 교육과정 단원별)</h1>")
        parts.append(f"<p class='muted'>시험 {len(index['exams'])}개 · 문제 {len(index['problems'])}개</p>")
        current_subject = None
        for uid, unit in UNITS.items():
            items = by_unit.get(uid)
            if not items:
                continue
            if unit.subject != current_subject:
                parts.append(f"<h2>{html.escape(unit.subject)}</h2>")
                current_subject = unit.subject
            parts.append(f"<h3>{html.escape(unit.chapter)} › {html.escape(unit.section)} <span class='muted'>({len(items)})</span></h3>")
            parts.append("<div class='grid'>")
            for m in sorted(items, key=lambda x: (x["exam_id"], x["order"])):
                c = m["classification"]
                gen = f"generated/{m['id']}/generated.html"
                gen_link = f" · <a href='{gen}'>생성 문제 {m.get('generated_count', 0)}개</a>" if m.get("generated_count") else ""
                parts.append(
                    "<div class='card'>"
                    f"<a href='{m['image']}'><img src='{m['image']}' loading='lazy'></a>"
                    f"<div><b>{html.escape(m['exam_title'])} {m['number']}번</b> · 난이도 {c['difficulty']}{gen_link}</div>"
                    f"<div class='muted'>{html.escape(', '.join(c['key_concepts']))}</div>"
                    f"<div class='muted'>id: {m['id']}</div>"
                    "</div>"
                )
            parts.append("</div>")
        pending = by_unit.get("_", [])
        if pending:
            parts.append(f"<h2>미분류 ({len(pending)})</h2><div class='grid'>")
            for m in sorted(pending, key=lambda x: (x["exam_id"], x["order"])):
                parts.append(
                    f"<div class='card'><img src='{m['image']}' loading='lazy'>"
                    f"<div><b>{html.escape(m['exam_title'])} {m['number']}번</b></div><div class='muted'>id: {m['id']}</div></div>"
                )
            parts.append("</div>")
        parts.append("</body></html>")
        out = self.root / "index.html"
        self.root.mkdir(parents=True, exist_ok=True)
        out.write_text("\n".join(parts), encoding="utf-8")
        return out


# ---------------------------------------------------------------- 렌더링

_HTML_HEAD = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{{delimiters:[{{left:'$$',right:'$$',display:true}},{{left:'$',right:'$',display:false}}]}})"></script>
<style>
 body{{font-family:system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:960px;margin:0 auto;padding:16px;line-height:1.7;color:#1d1d1f;background:#fff}}
 .muted{{color:#6b7280;font-size:.9em}} img{{max-width:min(100%,640px);border:1px solid #e5e7eb;border-radius:6px;background:#fff}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}}
 .card{{border:1px solid #e5e7eb;border-radius:8px;padding:10px}}
 .problem{{border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0}}
 .tag{{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:4px;padding:0 6px;margin-right:4px;font-size:.85em}}
 .ok{{color:#047857}} .warn{{color:#b91c1c}}
 details{{margin-top:8px}} summary{{cursor:pointer;color:#374151}}
</style></head><body>"""


def _h(text: str) -> str:
    return html.escape(text).replace("\n", "<br>")


def _verify_line(p: dict[str, Any]) -> str:
    v = p.get("verification")
    if not v:
        return "검산 안 함"
    if v.get("passed"):
        return "검산 통과 (독립 풀이 정답 일치)"
    msg = f"검산 불일치: 독립 풀이 답 = {v.get('answer')}"
    if v.get("issues"):
        msg += f" / 지적 사항: {v['issues']}"
    return msg


def render_markdown(meta: dict[str, Any], problems: list[dict[str, Any]]) -> str:
    c = meta.get("classification") or {}
    lines = [
        f"# {meta['exam_title']} {meta['number']}번 — 유사·연계 문제",
        "",
        f"![원본](../../{meta['image']})",
        "",
        f"- 단원: {c.get('unit_label', '미분류')}",
        f"- 핵심 개념: {', '.join(c.get('key_concepts', []))}",
        f"- 핵심 접근법: {c.get('solution_approach', '')}",
        "",
    ]
    marks = "①②③④⑤"
    for i, p in enumerate(problems, 1):
        lines += [
            f"## {i}. [{p['kind']}] {p['title']}",
            "",
            f"*{p['unit_label']} · 난이도 {p['difficulty']}*",
            "",
            p["statement"],
            "",
        ]
        if p.get("figure_description"):
            lines += [f"> 그림: {p['figure_description']}", ""]
        if p.get("choices"):
            lines += ["  ".join(f"{marks[j] if j < 5 else j + 1} {ch}" for j, ch in enumerate(p["choices"])), ""]
        lines += [
            "<details><summary>정답 및 풀이</summary>",
            "",
            f"**정답:** {p['answer']}",
            "",
            p["solution"],
            "",
            f"**원본과의 관계:** {p['relation_to_original']}",
            "",
            f"**공유 개념:** {', '.join(p['shared_concepts'])}",
            "",
            f"**{_verify_line(p)}**",
            "",
            "</details>",
            "",
        ]
    return "\n".join(lines)


def render_html(meta: dict[str, Any], problems: list[dict[str, Any]], image_rel: str) -> str:
    c = meta.get("classification") or {}
    marks = "①②③④⑤"
    parts = [_HTML_HEAD.format(title=html.escape(f"{meta['exam_title']} {meta['number']}번 연계 문제"))]
    parts.append(f"<h1>{html.escape(meta['exam_title'])} {meta['number']}번 — 유사·연계 문제</h1>")
    parts.append(f"<img src='{image_rel}' alt='원본 문제'>")
    parts.append(
        f"<p><span class='tag'>{html.escape(c.get('unit_label', '미분류'))}</span></p>"
        f"<p><b>핵심 개념</b> {_h(', '.join(c.get('key_concepts', [])))}<br>"
        f"<b>핵심 접근법</b> {_h(c.get('solution_approach', ''))}</p>"
    )
    for i, p in enumerate(problems, 1):
        v = p.get("verification")
        cls = "ok" if v and v.get("passed") else "warn"
        choices = ""
        if p.get("choices"):
            choices = "<p>" + " &nbsp; ".join(
                f"{marks[j] if j < 5 else j + 1} {_h(ch)}" for j, ch in enumerate(p["choices"])
            ) + "</p>"
        fig = f"<p class='muted'>[그림] {_h(p['figure_description'])}</p>" if p.get("figure_description") else ""
        parts.append(
            "<div class='problem'>"
            f"<div><span class='tag'>{html.escape(p['kind'])}</span><span class='tag'>{html.escape(p['unit_label'])}</span>"
            f"<span class='muted'>난이도 {p['difficulty']}</span></div>"
            f"<h3>{i}. {html.escape(p['title'])}</h3>"
            f"<p>{_h(p['statement'])}</p>{fig}{choices}"
            "<details><summary>정답 및 풀이</summary>"
            f"<p><b>정답</b> {_h(p['answer'])}</p><p>{_h(p['solution'])}</p>"
            f"<p><b>원본과의 관계</b> {_h(p['relation_to_original'])}</p>"
            f"<p><b>공유 개념</b> {_h(', '.join(p['shared_concepts']))}</p>"
            f"<p class='{cls}'>{_h(_verify_line(p))}</p>"
            "</details></div>"
        )
    parts.append("</body></html>")
    return "\n".join(parts)
