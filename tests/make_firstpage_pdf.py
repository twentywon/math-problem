"""실제 모의고사 1쪽처럼 큰 시험 제목이 가운데를 가로지르고, 쪽 번호 상자(1/12)가 아래 가운데에 있는 2단 PDF.

이런 1쪽에서 단 구분에 실패하면 오른쪽 단의 문항(3, 4번)을 놓치고 왼쪽 문항 이미지에 섞여 들어간다.
"""

from __future__ import annotations

import sys

import pymupdf

W, H = 728, 1031
L, R = 50, 392


def _text(page, x, y, lines, size=10):
    for j, t in enumerate(lines):
        page.insert_text((x, y + j * 17), t, fontname="korea", fontsize=size)


def make(path: str) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)
    # 1쪽 머리: 큰 제목 여러 줄이 가운데를 가로지른다 (위 10~25% 띠)
    page.insert_text((W / 2 - 200, 70), "2015학년도 3월 고1 전국연합학력평가 문제지", fontname="korea", fontsize=18)
    page.insert_text((W / 2 - 60, 115), "수학 영역", fontname="korea", fontsize=24)
    page.insert_text((W / 2 - 160, 150), "제 2 교시      성명            수험번호", fontname="korea", fontsize=12)
    page.insert_text((W / 2 - 110, 185), "5지선다형 · 단답형 30문항", fontname="korea", fontsize=12)
    page.draw_line((L, 200), (W - L, 200))
    page.draw_line((W / 2, 205), (W / 2, H - 80), width=0.8)
    for n, (x, y) in {1: (L, 230), 2: (L, 560), 3: (R, 230), 4: (R, 560)}.items():
        page.insert_text((x, y), f"{n}.", fontname="korea", fontsize=13)
        _text(page, x + 22, y, [f"식 x(2x + {n}) - x^2 을 간단히", "하면? [2점]", "① 1   ② 2   ③ 3   ④ 4   ⑤ 5"])
    # 아래 가운데 쪽 번호 상자 "1 / 12"
    page.draw_rect(pymupdf.Rect(W / 2 - 20, H - 70, W / 2 + 20, H - 46))
    page.insert_text((W / 2 - 17, H - 58), "1", fontname="helv", fontsize=9)
    page.insert_text((W / 2 + 4, H - 49), "12", fontname="helv", fontsize=9)
    doc.save(path)


if __name__ == "__main__":
    make(sys.argv[1])
