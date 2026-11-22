"""테스트용 2단 모의고사 PDF 를 만든다 (실제 시험지 레이아웃 흉내)."""

from __future__ import annotations

import sys

import pymupdf

W, H = 728, 1031  # B4 비슷한 비율
MARGIN, GAP = 50, 30
COL_W = (W - 2 * MARGIN - GAP) / 2


def make(path: str, numbers: list[int], per_col: int = 2) -> list[tuple[int, int, int]]:
    """numbers 순서대로 문제를 배치하고 (번호, 페이지, 단) 목록을 돌려준다."""
    doc = pymupdf.open()
    placed = []
    slots = per_col * 2
    for start in range(0, len(numbers), slots):
        page = doc.new_page(width=W, height=H)
        page_no = start // slots
        page.insert_text((W / 2 - 60, 40), "수학 영역  (홀수형)", fontname="korea", fontsize=16)
        page.draw_line((MARGIN, 55), (W - MARGIN, 55))
        page.draw_line((W / 2, 70), (W / 2, H - 70), width=0.8)  # 단 구분선
        for k, n in enumerate(numbers[start : start + slots]):
            col = k // per_col
            row = k % per_col
            x = MARGIN + col * (COL_W + GAP)
            y = 90 + row * ((H - 200) / per_col)
            page.insert_text((x, y), f"{n}.", fontname="korea", fontsize=13)  # 큰 번호
            body = [
                f"함수 f(x) = x^2 - {n}x + 3 에 대하여",
                "다음 조건을 만족시키는 실수 a 의",
                "값을 구하시오.",
                "(가) f(a) = 0",
                "2. 본문 속 숫자 (문제 번호 아님)",
                "① 1   ② 2   ③ 3   ④ 4   ⑤ 5",
            ]
            for j, t in enumerate(body):
                page.insert_text((x + 22, y + j * 18), t, fontname="korea", fontsize=10)
            if n % 3 == 0:  # 그래프가 있는 문제
                r = pymupdf.Rect(x + 40, y + 100, x + 200, y + 220)
                page.draw_rect(r)
                page.draw_line((r.x0, r.y1 - 20), (r.x1, r.y0 + 10))
            placed.append((n, page_no, col))
        page.insert_text((W / 2 - 4, H - 40), str(page_no + 1), fontname="korea", fontsize=10)
        page.insert_text((MARGIN, H - 22), "이 문제지에 관한 저작권은 한국교육과정평가원에 있습니다.", fontname="korea", fontsize=8)
    doc.save(path)
    return placed


if __name__ == "__main__":
    make(sys.argv[1], list(range(1, 13)) + list(range(23, 27)) + list(range(23, 27)))
