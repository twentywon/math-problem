"""API 없이 전체 흐름(자르기 → 분류 → 저장 → 생성/검산 → HTML)을 검증한다."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from mathgen import cli
from mathgen.curriculum import UNITS, get_unit
from mathgen.generate import normalize_answer
from mathgen.pdf_split import Marker, select_sequence
from mathgen.storage import Library

from .make_sample_pdf import make


class FakeStream:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return SimpleNamespace(
            stop_reason="end_turn",
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=json.dumps(self.payload))],
        )


class FakeClient:
    """시스템 프롬프트로 어떤 호출인지 구분해 그럴듯한 JSON 을 돌려준다."""

    def __init__(self):
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kw):
        self.calls.append(kw)
        system = kw["system"][0]["text"]
        assert kw["output_config"]["format"]["type"] == "json_schema"
        assert kw["fallbacks"] == "default"
        if "검토자" in system:
            return FakeStream({"answer": "③", "well_posed": True, "issues": "", "solution_brief": "..."})
        if "출제 경험" in system:
            p = {
                "kind": "유사문제",
                "title": "이차함수의 근",
                "statement": "함수 $f(x)=x^2-5x+6$ 에 대하여 $f(a)=0$ 인 가장 큰 $a$ 는?",
                "choices": ["1", "2", "3", "4", "5"],
                "figure_description": "",
                "answer": "3",
                "solution": "$(x-2)(x-3)=0$",
                "shared_concepts": ["인수분해"],
                "relation_to_original": "수치만 바꿈",
                "unit_id": "CM1-2-2",
                "difficulty": 9,
            }
            return FakeStream({"problems": [p, dict(p, kind="개념연계문제", answer="4")]})
        return FakeStream(
            {
                "transcription": "함수 $f(x)=x^2-x+3$ ...",
                "figure_description": "",
                "question_type": "5지선다",
                "primary_unit_id": "CM1-2-2",
                "secondary_unit_ids": ["CM1-2-2", "CM1-1-3"],
                "key_concepts": ["이차방정식의 근"],
                "solution_approach": "인수분해",
                "answer": "3",
                "solution": "...",
                "difficulty": 2,
            }
        )


@pytest.fixture
def sample(tmp_path: Path):
    pdf = tmp_path / "2026_3월_고1.pdf"
    make(str(pdf), list(range(1, 13)) + list(range(23, 27)) + list(range(23, 27)))
    return pdf


def test_curriculum_ids_unique_and_labels():
    assert len(UNITS) == len(set(UNITS))
    assert get_unit("CAL2-1-2").label == "미적분II > 수열의 극한 > 급수"
    assert get_unit("ALG-2-1").path_parts == ("03_대수", "02_삼각함수", "01_삼각함수")


def test_select_sequence_ignores_noise_and_detects_sections():
    s = ("F", 13, True)
    body = ("F", 10, False)
    ms = [Marker(n, 0, 0, y * 10, 0, s) for y, n in enumerate([1, 2, 3, 4])]
    ms += [Marker(2, 0, 0, 25, 0, body)]  # 본문 속 "2."
    ms += [Marker(n, 1, 0, y * 10, 0, s) for y, n in enumerate([5, 6, 3, 4])]  # 3,4 는 새 구간
    got = [(m.number, sec) for m, sec in select_sequence(ms)]
    assert got == [(1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (3, 1), (4, 1)]


def test_normalize_answer():
    assert normalize_answer("③") == normalize_answer("3") == normalize_answer(" $3$ ")
    assert normalize_answer("\\dfrac{1}{2}") == normalize_answer("\\frac{1}{2}")


def test_full_pipeline(sample: Path, tmp_path: Path, monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(cli, "_client", lambda: fake)
    lib_dir = tmp_path / "lib"

    cli.main(["--library", str(lib_dir), "ingest", str(sample)])
    lib = Library(lib_dir)
    index = lib.load()
    assert len(index["problems"]) == 20
    sections = [m["section"] for m in index["problems"].values()]
    assert sections.count(1) == 4
    m = index["problems"]["2026_3월_고1_q01"]
    assert m["unit_id"] == "CM1-2-2"
    assert m["classification"]["secondary_unit_ids"] == ["CM1-1-3"]  # 주 단원 중복 제거
    unit_img = lib_dir / m["unit_image"]
    assert unit_img.exists()
    assert "01_공통수학1/02_방정식과 부등식/02_이차방정식과 이차함수" in unit_img.as_posix()

    # 재분류하면 이전 단원 폴더의 사본이 지워진다
    cli.main(["--library", str(lib_dir), "classify", "2026_3월_고1_q01"])
    assert unit_img.exists()

    cli.main(["--library", str(lib_dir), "generate", "2026_3월_고1_q01", "--similar", "1", "--concept", "1", "--variant", "0"])
    out = lib_dir / "generated" / "2026_3월_고1_q01"
    data = json.loads((out / "generated.json").read_text(encoding="utf-8"))
    assert [p["verification"]["passed"] for p in data] == [True, False]  # 두 번째는 답 불일치
    assert data[0]["difficulty"] == 5  # 범위로 잘림
    html = (out / "generated.html").read_text(encoding="utf-8")
    assert "검산 불일치" in html and "katex" in html
    assert (lib_dir / "index.html").exists()
    assert lib.load()["problems"]["2026_3월_고1_q01"]["generated_count"] == 2


def test_inbox(sample: Path, tmp_path: Path, monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(cli, "_client", lambda: fake)
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    sample.rename(inbox / sample.name)
    cli.main(["--library", str(tmp_path / "lib"), "inbox", "--inbox", str(inbox)])
    assert (inbox / "done" / sample.name).exists()
    assert len(Library(tmp_path / "lib").load()["problems"]) == 20


def test_vision_mode_for_scanned_pdf(sample: Path, tmp_path: Path):
    """텍스트 레이어가 없는 스캔본은 Claude 가 알려준 좌표로 자른다."""
    import pymupdf

    from mathgen.pdf_split import split_pdf

    src = pymupdf.open(str(sample))
    scanned = pymupdf.open()
    for page in list(src)[:1]:
        new = scanned.new_page(width=page.rect.width, height=page.rect.height)
        new.insert_image(new.rect, pixmap=page.get_pixmap(dpi=100))
    scan_path = tmp_path / "scan.pdf"
    scanned.save(str(scan_path))

    layout = {
        "columns": [{"x0": 60, "x1": 495}, {"x0": 505, "x1": 940}],
        "problems": [
            {"number": 1, "column": 0, "y_top": 70},
            {"number": 2, "column": 0, "y_top": 470},
            {"number": 3, "column": 1, "y_top": 70},
            {"number": 4, "column": 1, "y_top": 470},
        ],
        "column_bottoms": [600, 600],
    }

    class VisionClient(FakeClient):
        def _stream(self, **kw):
            self.calls.append(kw)
            return FakeStream(layout)

    client = VisionClient()
    crops = split_pdf(scan_path, tmp_path / "out", mode="auto", client=client)
    assert [c.number for c in crops] == [1, 2, 3, 4]
    assert len(client.calls) == 1 and client.calls[0]["messages"][0]["content"][0]["type"] == "image"
    assert all((tmp_path / "out" / c.image).stat().st_size > 1000 for c in crops)

    with pytest.raises(RuntimeError, match="vision"):
        split_pdf(scan_path, tmp_path / "out2", mode="auto", client=None)


def test_shared_material_is_attached(tmp_path: Path):
    """[11~12] 공통 자료는 11·12번 이미지 위에 붙고, 앞 문항(10번)에는 들어가지 않는다."""
    from PIL import Image

    from mathgen.pdf_split import split_pdf

    from .make_group_pdf import make as make_group

    pdf = tmp_path / "group.pdf"
    make_group(str(pdf))
    crops = split_pdf(pdf, tmp_path / "out")
    assert [(c.number, c.shared) for c in crops] == [(10, ""), (11, "11~12"), (12, "11~12"), (13, "")]
    h = {c.number: Image.open(tmp_path / "out" / c.image).height for c in crops}
    assert h[12] > h[13] * 3  # 12번은 오른쪽 단 맨 위지만 공통 자료가 붙어 길다
    assert h[10] < h[11] / 3  # 10번에는 공통 자료가 섞이지 않는다
