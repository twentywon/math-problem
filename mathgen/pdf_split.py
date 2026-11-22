"""모의고사 PDF 를 문제 단위 이미지로 자른다.

두 가지 방식이 있다.

1. text 모드 (기본): PDF 안의 텍스트 레이어에서 "1.", "2." ... 처럼 단(column)의
   왼쪽 끝에 놓인 문제 번호를 찾고, 다음 문제 번호 직전(또는 단의 끝)까지를 자른다.
   평가원/교육청 배포 PDF 처럼 글자가 선택되는 PDF 에서 빠르고 정확하며 API 비용이 없다.
   "[11~12] 그림과 같이 …" 처럼 여러 문항이 함께 쓰는 공통 자료는 해당 문항 이미지마다 위에 붙인다.
2. vision 모드: 스캔본처럼 텍스트 레이어가 없으면 페이지 이미지를 Claude 에게 보여주고
   단 경계와 문제 번호의 세로 위치를 받아 같은 방식으로 자른다.

auto 모드는 페이지별로 텍스트가 있으면 1, 없으면 2를 쓴다.
"""

from __future__ import annotations

import io
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from statistics import median
from typing import Any, Iterable

import pymupdf
from PIL import Image, ImageDraw

# ---------------------------------------------------------------- 데이터 구조


@dataclass
class Column:
    x0: float
    x1: float


@dataclass
class Marker:
    number: int
    page: int
    col: int
    y: float  # 문제 번호 줄의 윗변 (PDF 좌표, pt)
    x: float
    style: tuple = ()


@dataclass
class SharedBlock:
    """여러 문항이 함께 쓰는 공통 자료의 머리줄 ("[11~12] 그림과 같이 …")."""

    first: int
    last: int
    page: int
    col: int
    y: float

    @property
    def label(self) -> str:
        return f"{self.first}~{self.last}"


@dataclass
class PageLayout:
    columns: list[Column]
    footer_top: list[float]  # 단별로 이 y 아래는 꼬리말(쪽번호, 저작권 문구 등)
    content_bottom: list[float]  # 단별 내용의 마지막 y
    markers: list[Marker] = field(default_factory=list)
    groups: list[SharedBlock] = field(default_factory=list)


@dataclass
class ProblemCrop:
    order: int  # 시험지 안에서의 순서(1부터)
    number: int  # 인쇄된 문제 번호
    section: int  # 번호가 다시 1(또는 23 등)부터 시작하면 증가 (선택과목 구간 구분)
    page: int  # 0부터
    rect: tuple[float, float, float, float]
    image: str = ""  # 저장된 파일 이름
    shared: str = ""  # 공통 자료를 쓰는 문항이면 그 범위 ("11~12")
    shared_page: int = -1
    shared_rect: tuple[float, float, float, float] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------- 텍스트 레이어 분석

_MARKER_RE = re.compile(r"^\s*(\d{1,2})\s*[.．](?!\d)")
_BARE_NUMBER_RE = re.compile(r"^\s*(\d{1,2})\s*$")
# 여러 문항이 함께 쓰는 공통 자료의 머리: "[11~12] 그림과 같이 …"
_GROUP_RE = re.compile(r"^\s*[\[［]\s*(\d{1,2})\s*[~～∼〜\-–]\s*(\d{1,2})\s*[\]］]")
_FOOTER_TEXT_RE = re.compile(r"(저작권|평가원|교육청|교육과정|이 문제지|확인\s*사항)")
# 쪽 번호 형태: "3", "- 3 -", "3/8", "3(8)"
_PAGE_NUMBER_RE = re.compile(
    r"^\s*(?:[-–]?\s*\d{1,2}\s*[-–]?|\d{1,2}\s*/\s*\d{1,2}|\d{1,2}\s*\(\s*\d{1,2}\s*\))\s*$"
)


@dataclass
class _Line:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    first_span_text: str
    style: tuple


def _lines(page: pymupdf.Page) -> list[_Line]:
    out: list[_Line] = []
    d = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE)
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
            if not spans:
                continue
            text = "".join(s["text"] for s in spans)
            x0, y0, x1, y1 = line["bbox"]
            s0 = spans[0]
            style = (s0.get("font", ""), round(s0.get("size", 0), 1), bool(s0.get("flags", 0) & 16))
            out.append(_Line(text, x0, y0, x1, y1, s0["text"], style))
    return out


def has_text_layer(page: pymupdf.Page, min_chars: int = 30) -> bool:
    return len(page.get_text("text").strip()) >= min_chars


def detect_columns(page: pymupdf.Page, lines: list[_Line]) -> list[Column]:
    """페이지 가운데 부근의 세로 빈 띠를 찾아 1단/2단을 판별한다."""
    W, H = page.rect.width, page.rect.height
    # 제목처럼 전체 폭을 쓰는 줄, 머리말(위 10%)·꼬리말(아래 8%) 띠의 줄은 제외
    usable = [ln for ln in lines if (ln.x1 - ln.x0) < 0.6 * W and ln.y0 > 0.1 * H and ln.y1 < 0.92 * H]
    if not usable:
        return [Column(0, W)]
    left = min(ln.x0 for ln in usable)
    right = max(ln.x1 for ln in usable)
    lo, hi = int(W * 0.3), int(W * 0.7)
    cover: list[int] = []  # 아래 tries 에서 채운다

    def find_gap(tol: int) -> tuple[int, int]:
        best = (0, 0)  # (길이, 시작)
        run_start = None
        for x in range(lo, hi + 2):
            if x <= hi and cover[x] <= tol:
                if run_start is None:
                    run_start = x
            elif run_start is not None:
                if x - run_start > best[0]:
                    best = (x - run_start, run_start)
                run_start = None
        return best

    def coverage(subset: list[_Line]) -> list[int]:
        cov = [0] * (int(W) + 2)
        for ln in subset:
            for x in range(max(0, int(ln.x0)), min(len(cov), int(ln.x1) + 1)):
                cov[x] += 1
        return cov

    # 단 사이 빈 띠를 여러 방법으로 찾는다. 첫 쪽의 큰 시험 제목처럼 가운데를 가로지르는 줄이 띠를 가릴 수 있다.
    straddle = [ln for ln in usable if ln.x0 < W / 2 - 4 and ln.x1 > W / 2 + 4]
    tries = [(usable, 0), ([ln for ln in usable if ln.y0 > 0.25 * H], 0)]
    if len(straddle) <= 0.25 * len(usable):
        tries.append(([ln for ln in usable if ln not in straddle], 0))
    tries.append((usable, int(0.03 * len(usable))))
    best = (0, 0)
    for subset, tol in tries:
        if len(subset) < 6:
            continue
        cover = coverage(subset)
        best = find_gap(tol)
        if best[0] >= 8:
            break
    if best[0] < 8:
        # 마지막으로 문항 번호 위치로 판단: 왼쪽 끝과 가운데 오른쪽에 모두 "n." 으로 시작하는 줄이 있으면 2단
        marks = [ln for ln in lines if _MARKER_RE.match(ln.text) and 0.08 * H < ln.y0 and ln.y1 < 0.92 * H]
        lefts = [ln.x0 for ln in marks if ln.x0 < 0.3 * W]
        rights = [ln.x0 for ln in marks if 0.42 * W < ln.x0 < 0.75 * W]
        if lefts and rights:
            rx = min(rights)
            return [Column(max(0, left - 4), rx - 8), Column(rx - 4, min(W, right + 4))]
    if best[0] >= 8:
        # 단 경계는 빈 띠의 가운데(구분선 자리)에서 3pt 떨어진 곳: 글자 폭 오차로 끝 글자가 잘리지 않게
        mid = best[1] + best[0] / 2
        m = max(1, min(3, best[0] / 2 - 1))
        return [Column(max(0, left - 4), mid - m), Column(mid + m, min(W, right + 4))]
    return [Column(max(0, left - 4), min(W, right + 4))]


def _col_of(x0: float, x1: float, columns: list[Column]) -> int | None:
    cx = (x0 + x1) / 2
    for i, c in enumerate(columns):
        if c.x0 - 2 <= cx <= c.x1 + 2:
            return i
    return None


def _footer_tops(page: pymupdf.Page, lines: list[_Line], columns: list[Column]) -> list[float]:
    H = page.rect.height
    tops = [H] * len(columns)
    for ln in lines:
        if _FOOTER_TEXT_RE.search(ln.text):
            is_notice = "확인" in ln.text and "사항" in ln.text
            if not (ln.y0 > 0.85 * H or is_notice):
                continue
        elif _PAGE_NUMBER_RE.match(ln.text):
            # 쪽 번호: 맨 아래 띠, 또는 아래쪽 가운데·바깥 가장자리 (그래프 눈금 숫자와 구분)
            cx = (ln.x0 + ln.x1) / 2
            placed = abs(cx - page.rect.width / 2) < 0.12 * page.rect.width or cx < 0.12 * page.rect.width or cx > 0.88 * page.rect.width
            if not (ln.y0 > 0.93 * H or (ln.y0 > 0.87 * H and placed)):
                continue
        else:
            continue
        if (ln.x1 - ln.x0) > 0.6 * page.rect.width or _col_of(ln.x0, ln.x1, columns) is None:
            tops = [min(t, ln.y0) for t in tops]  # 전체 폭 꼬리말
        else:
            c = _col_of(ln.x0, ln.x1, columns)
            tops[c] = min(tops[c], ln.y0)
    return tops


def _content_boxes(page: pymupdf.Page, lines: list[_Line]) -> list[tuple[float, float, float, float]]:
    W, H = page.rect.width, page.rect.height
    boxes = [(ln.x0, ln.y0, ln.x1, ln.y1) for ln in lines]
    for d in page.get_drawings():
        r = d.get("rect")
        if r is None:
            continue
        w, h = r.width, r.height
        if w > 0.8 * W or (w < 3 and h > 0.4 * H):  # 페이지 테두리, 단 구분선
            continue
        boxes.append((r.x0, r.y0, r.x1, r.y1))
    for info in page.get_image_info():
        x0, y0, x1, y1 = info["bbox"]
        boxes.append((x0, y0, x1, y1))
    return boxes


def _content_bottoms(page, lines, columns, footer_tops) -> list[float]:
    bottoms = [0.0] * len(columns)
    for x0, y0, x1, y1 in _content_boxes(page, lines):
        c = _col_of(x0, x1, columns)
        if c is None or y1 > footer_tops[c]:
            continue
        bottoms[c] = max(bottoms[c], y1)
    return bottoms


def _column_left(col_lines: list[_Line], col: Column) -> float:
    """단의 왼쪽 끝: 단 안에서 시작하고, 같은 위치(±3pt)에서 시작하는 줄이 2개 이상인 가장 왼쪽 x.

    가운데 제목처럼 단 경계에 걸친 조각 하나 때문에 기준이 틀어지지 않게 한다.
    """
    xs = sorted(ln.x0 for ln in col_lines if ln.x0 >= col.x0 - 2)
    if not xs:
        return min(ln.x0 for ln in col_lines)
    for x in xs:
        if sum(1 for y in xs if abs(y - x) <= 3) >= 2:
            return x
    return xs[0]


def _text_markers(page_no: int, lines: list[_Line], columns: list[Column]) -> tuple[list[Marker], list[SharedBlock]]:
    body_sizes = [ln.style[1] for ln in lines if ln.style[1] > 0]
    body = median(body_sizes) if body_sizes else 0
    by_col: dict[int, list[_Line]] = {}
    for ln in lines:
        c = _col_of(ln.x0, ln.x0 + 1, columns)  # 줄의 시작점이 어느 단에 있는지
        if c is not None:
            by_col.setdefault(c, []).append(ln)
    markers: list[Marker] = []
    groups: list[SharedBlock] = []
    for c, col_lines in by_col.items():
        col_left = _column_left(col_lines, columns[c])
        for ln in col_lines:
            if ln.x0 - col_left > 14:  # 문제 번호·공통 자료 머리는 단의 왼쪽 끝에 붙어 있다
                continue
            g = _GROUP_RE.match(ln.text)
            if g:
                a, b = int(g.group(1)), int(g.group(2))
                if 1 <= a < b and b - a <= 6:
                    groups.append(SharedBlock(a, b, page_no, c, ln.y0))
                continue
            m = _MARKER_RE.match(ln.text)
            if not m:
                b = _BARE_NUMBER_RE.match(ln.first_span_text)
                # 점 없이 굵거나 큰 숫자만 있는 형식 (예: 네모 칸 안의 번호)
                if b and (ln.style[2] or ln.style[1] > body * 1.1):
                    m = b
            if not m:
                continue
            n = int(m.group(1))
            if 1 <= n <= 50:
                markers.append(Marker(n, page_no, c, ln.y0, ln.x0, ln.style))
    return markers, groups


# ---------------------------------------------------------------- 번호 순서 정리


def select_sequence(markers: Iterable[Marker]) -> list[tuple[Marker, int]]:
    """후보 번호들 중 실제 문제 번호열을 고른다. (marker, section) 목록을 돌려준다.

    - 가장 많은 서로 다른 번호를 가진 글꼴 스타일을 '문제 번호 스타일'로 본다.
    - 그 뒤 읽는 순서대로 n, n+1, ... 이 이어지는 것만 채택한다.
    - 번호가 줄어들면(예: 30 → 23) 선택과목 등 새 구간으로 보고 section 을 올린다.
    - 번호를 건너뛴 경우(번호 인식 실패 등)는 뒤 번호가 이어질 때만 받아들인다.
    """
    ms = sorted(markers, key=lambda m: (m.page, m.col, m.y))
    if not ms:
        return []
    styles: dict[tuple, set[int]] = {}
    for m in ms:
        if m.style != ("vision",):
            styles.setdefault(m.style, set()).add(m.number)
    if styles:
        dominant = max(styles, key=lambda s: len(styles[s]))
        if len(styles[dominant]) >= 3:
            ms = [m for m in ms if m.style in (dominant, ("vision",))]

    picked: list[tuple[Marker, int]] = []
    last: int | None = None
    section = 0
    for i, m in enumerate(ms):
        if last is None or m.number == last + 1:
            picked.append((m, section))
            last = m.number
        elif m.number != last:
            # 번호가 건너뛰거나(놓친 번호) 줄어들면(새 구간) 바로 뒤 후보들이 이어질 때만 채택
            later = [x.number for x in ms[i + 1 : i + 4]]
            if m.number + 1 in later or (m.number < last and m.number == 1):
                if m.number < last:
                    section += 1
                picked.append((m, section))
                last = m.number
    return picked


# ---------------------------------------------------------------- vision 모드

_VISION_SYSTEM = """너는 한국 수학 시험지(모의고사) 페이지 이미지의 레이아웃을 읽는 도구다.
페이지에서 다음을 찾아라.
- columns: 본문 단(column)의 좌우 경계. 보통 2단이며, 1단이면 하나만.
- problems: 이 페이지에서 '시작하는' 각 문제의 인쇄된 번호(number), 몇 번째 단인지(column, 0부터),
  문제 번호가 찍힌 줄의 윗변 y 좌표(y_top).
- groups: 여러 문제가 함께 쓰는 공통 자료(지문·그림)의 머리줄. "[11~12] 그림과 같이 …" 처럼 시작한다.
  from, to(문항 범위), column, y_top(머리줄 윗변). 없으면 빈 배열.
- column_bottoms: 각 단에서 문제 내용(그림, 선택지 포함)이 끝나는 y 좌표. 쪽 번호, 저작권 문구 같은 꼬리말은 제외.
좌표는 모두 페이지 왼쪽 위가 (0,0), 오른쪽 아래가 (1000,1000) 인 정규화 좌표 정수로 답한다.
문제 번호가 아닌 숫자(선택지 번호, 보기의 번호, 쪽 번호)는 넣지 마라."""

_VISION_SCHEMA = {
    "type": "object",
    "properties": {
        "columns": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"x0": {"type": "integer"}, "x1": {"type": "integer"}},
                "required": ["x0", "x1"],
                "additionalProperties": False,
            },
        },
        "problems": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "number": {"type": "integer"},
                    "column": {"type": "integer"},
                    "y_top": {"type": "integer"},
                },
                "required": ["number", "column", "y_top"],
                "additionalProperties": False,
            },
        },
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "integer"},
                    "to": {"type": "integer"},
                    "column": {"type": "integer"},
                    "y_top": {"type": "integer"},
                },
                "required": ["from", "to", "column", "y_top"],
                "additionalProperties": False,
            },
        },
        "column_bottoms": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["columns", "problems", "groups", "column_bottoms"],
    "additionalProperties": False,
}


def _vision_layout(client: Any, page: pymupdf.Page, page_no: int) -> PageLayout:
    from .llm import ask_json, image_block

    W, H = page.rect.width, page.rect.height
    png = page.get_pixmap(dpi=110).tobytes("png")
    data = ask_json(
        client,
        system=_VISION_SYSTEM,
        content=[image_block(png), {"type": "text", "text": "이 페이지의 레이아웃을 JSON 으로 답하라."}],
        schema=_VISION_SCHEMA,
        effort="medium",
        max_tokens=16000,
    )
    cols = [Column(c["x0"] / 1000 * W, c["x1"] / 1000 * W) for c in data["columns"]] or [Column(0, W)]
    cols.sort(key=lambda c: c.x0)
    bottoms = [b / 1000 * H for b in data.get("column_bottoms", [])]
    bottoms = (bottoms + [H * 0.95] * len(cols))[: len(cols)]
    markers = []
    for p in data["problems"]:
        c = min(max(p["column"], 0), len(cols) - 1)
        markers.append(Marker(p["number"], page_no, c, p["y_top"] / 1000 * H, cols[c].x0, ("vision",)))
    groups = []
    for g in data.get("groups", []):
        if g["to"] > g["from"]:
            c = min(max(g["column"], 0), len(cols) - 1)
            groups.append(SharedBlock(g["from"], g["to"], page_no, c, g["y_top"] / 1000 * H))
    footer = [min(H, b + 0.02 * H) for b in bottoms]
    return PageLayout(cols, footer, bottoms, markers, groups)


# ---------------------------------------------------------------- 자르기


def analyze(doc: pymupdf.Document, mode: str = "auto", client: Any = None) -> list[PageLayout]:
    layouts: list[PageLayout] = []
    for page_no, page in enumerate(doc):
        use_text = mode == "text" or (mode == "auto" and has_text_layer(page))
        if use_text:
            lines = _lines(page)
            cols = detect_columns(page, lines)
            footer = _footer_tops(page, lines, cols)
            bottoms = _content_bottoms(page, lines, cols, footer)
            markers, groups = _text_markers(page_no, lines, cols)
            layouts.append(PageLayout(cols, footer, bottoms, markers, groups))
        else:
            if client is None:
                raise RuntimeError(
                    f"{page_no + 1}쪽에 텍스트 레이어가 없습니다. 스캔본은 vision 모드(Claude API)가 필요합니다."
                )
            layouts.append(_vision_layout(client, page, page_no))
    return layouts


def compute_crops(doc: pymupdf.Document, layouts: list[PageLayout]) -> list[ProblemCrop]:
    all_markers = [m for lay in layouts for m in lay.markers]
    seq = select_sequence(all_markers)
    groups = [g for lay in layouts for g in lay.groups]
    starts = [(m.page, m.col, m.y) for m, _ in seq] + [(g.page, g.col, g.y) for g in groups]

    def rect_for(page: int, c: int, y: float) -> tuple[float, float, float, float]:
        lay = layouts[page]
        col = lay.columns[c]
        # 같은 페이지·같은 단에서 다음 문항 번호나 다음 공통 자료 머리 직전까지
        nxt = [sy for sp, sc, sy in starts if sp == page and sc == c and sy > y + 1]
        if nxt:
            y1 = min(nxt) - 3
        else:
            y1 = min(lay.footer_top[c] - 2, max(lay.content_bottom[c], y + 20) + 6)
        y0 = max(0, y - 4)
        return (col.x0, y0, col.x1, max(y1, y0 + 20))

    crops: list[ProblemCrop] = []
    for i, (m, section) in enumerate(seq):
        crops.append(ProblemCrop(order=i + 1, number=m.number, section=section, page=m.page, rect=rect_for(m.page, m.col, m.y)))

    # 공통 자료 뒤에 이어 나오는 first~last 번 문항에 공통 자료 영역을 연결한다
    for g in groups:
        g_rect = rect_for(g.page, g.col, g.y)
        expect = g.first
        for (m, _), c in zip(seq, crops):
            if (m.page, m.col, m.y) < (g.page, g.col, g.y):
                continue
            if m.number == expect:
                c.shared, c.shared_page, c.shared_rect = g.label, g.page, g_rect
                expect += 1
                if expect > g.last:
                    break
            elif expect > g.first:
                break
    return crops


def trim_whitespace(png: bytes, pad: int = 16, threshold: int = 235) -> bytes:
    img = Image.open(io.BytesIO(png)).convert("RGB")
    mask = img.convert("L").point(lambda v: 255 if v < threshold else 0)
    # 가장자리 근처에서 위아래로 거의 끝까지 이어진 세로줄(단 구분선, 테두리)은 지운다
    w, h = mask.size
    edge = max(24, int(w * 0.06))
    px = mask.load()
    draw = ImageDraw.Draw(img)
    for x in list(range(min(edge, w))) + list(range(max(edge, w - edge), w)):
        if sum(1 for y in range(h) if px[x, y]) > h * 0.85:
            for y in range(h):
                px[x, y] = 0
            draw.line((x, 0, x, h), fill=(255, 255, 255))
    bbox = mask.getbbox()
    if bbox:
        x0, y0, x1, y1 = bbox
        img = img.crop((max(0, x0 - pad), max(0, y0 - pad), min(img.width, x1 + pad), min(img.height, y1 + pad)))
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def render_crop(page: pymupdf.Page, rect: tuple[float, float, float, float], dpi: int = 200) -> bytes:
    pix = page.get_pixmap(clip=pymupdf.Rect(*rect), dpi=dpi)
    return trim_whitespace(pix.tobytes("png"))


_KOREAN_FONTS = [
    "C:/Windows/Fonts/malgun.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
]


def _label_font(size: int = 18):
    from PIL import ImageFont

    for f in _KOREAN_FONTS:
        if Path(f).exists():
            try:
                return ImageFont.truetype(f, size), True
            except OSError:
                pass
    try:
        return ImageFont.load_default(size=size), False
    except TypeError:  # 오래된 Pillow
        return ImageFont.load_default(), False


def compose_shared(shared_png: bytes, problem_png: bytes, label: str) -> bytes:
    """공통 자료 이미지를 문항 이미지 위에 붙인다."""
    a = Image.open(io.BytesIO(shared_png)).convert("RGB")
    b = Image.open(io.BytesIO(problem_png)).convert("RGB")
    band, gap = 34, 18
    w = max(a.width, b.width)
    out = Image.new("RGB", (w, band + a.height + gap + b.height), (255, 255, 255))
    draw = ImageDraw.Draw(out)
    draw.rectangle((0, 0, w, band), fill=(230, 238, 246))
    font, korean = _label_font()
    draw.text((12, 7), f"공통 자료 [{label}]" if korean else f"SHARED [{label}]", fill=(47, 93, 138), font=font)
    out.paste(a, (0, band))
    y = band + a.height + gap // 2
    for x in range(0, w, 14):
        draw.line((x, y, min(w, x + 8), y), fill=(154, 164, 174), width=2)
    out.paste(b, (0, band + a.height + gap))
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _save_check_images(doc, crops: list[ProblemCrop], out_dir: Path, dpi: int = 80) -> None:
    """검수용: 각 페이지 위에 자른 영역을 빨간 상자로 그린 이미지."""
    check = out_dir / "_check"
    check.mkdir(parents=True, exist_ok=True)
    scale = dpi / 72
    for page_no, page in enumerate(doc):
        img = Image.open(io.BytesIO(page.get_pixmap(dpi=dpi).tobytes("png"))).convert("RGB")
        draw = ImageDraw.Draw(img)
        for c in crops:
            if c.shared_rect and c.shared_page == page_no:
                x0, y0, x1, y1 = (v * scale for v in c.shared_rect)
                draw.rectangle((x0, y0, x1, y1), outline=(47, 93, 138), width=2)
                draw.text((x0 + 3, y1 - 12), f"[{c.shared}]", fill=(47, 93, 138))
            if c.page != page_no:
                continue
            x0, y0, x1, y1 = (v * scale for v in c.rect)
            draw.rectangle((x0, y0, x1, y1), outline=(220, 0, 0), width=2)
            draw.text((x0 + 3, y0 + 2), f"#{c.order}", fill=(220, 0, 0))
        img.save(check / f"page_{page_no + 1:02d}.png")


def split_pdf(
    pdf_path: str | Path,
    out_dir: str | Path,
    *,
    mode: str = "auto",
    dpi: int = 200,
    client: Any = None,
    check_images: bool = True,
) -> list[ProblemCrop]:
    """PDF 를 문제별 PNG 로 잘라 out_dir 에 q01.png, q02.png ... 로 저장한다."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(str(pdf_path))
    try:
        layouts = analyze(doc, mode=mode, client=client)
        crops = compute_crops(doc, layouts)
        shared_cache: dict[tuple, bytes] = {}
        for c in crops:
            c.image = f"q{c.order:02d}.png"
            png = render_crop(doc[c.page], c.rect, dpi=dpi)
            if c.shared_rect:
                key = (c.shared_page, c.shared_rect)
                if key not in shared_cache:
                    shared_cache[key] = render_crop(doc[c.shared_page], c.shared_rect, dpi=dpi)
                png = compose_shared(shared_cache[key], png, c.shared)
            (out_dir / c.image).write_bytes(png)
        if check_images:
            _save_check_images(doc, crops, out_dir)
    finally:
        doc.close()
    return crops
