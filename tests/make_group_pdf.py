"""공통 자료("[11~12] 그림과 같이 …")가 있는 2단 시험지 PDF 를 만든다 (실제 모의고사 4쪽 구성 흉내)."""

from __future__ import annotations

import sys

import pymupdf

W, H = 728, 1031
L, R = 50, 392  # 왼쪽·오른쪽 단 시작 x


def _text(page, x, y, lines, size=10):
    for j, t in enumerate(lines):
        page.insert_text((x, y + j * 17), t, fontname="korea", fontsize=size)


def make(path: str) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)
    page.insert_text((W / 2 - 40, 40), "수학 영역", fontname="korea", fontsize=16)
    page.draw_line((L, 55), (W - L, 55))
    page.draw_line((W / 2, 70), (W / 2, H - 70), width=0.8)
    # 왼쪽 단: 10번 → 공통 자료 [11~12] → 11번
    page.insert_text((L, 90), "10.", fontname="korea", fontsize=13)
    _text(page, L + 22, 90, ["다항식 x^3 - 2x + 1 을 x - 1 로", "나눈 나머지는? [3점]", "① 0   ② 1   ③ 2   ④ 3   ⑤ 4"])
    _text(page, L, 300, ["[11～12] 그림과 같이 이차함수 y=-x(x-6)", "의 그래프가 x 축과 만나는 점 중 원점 O 가",
                         "아닌 점을 A 라 하고, 제1사분면에 있는", "그래프 위의 점을 P 라 하자. 11번과 12번의",
                         "두 물음에 답하시오."])
    # 그래프 (공통 자료의 그림)
    pts = [(L + 60 + t * 3, 560 - (t / 10) * (6 - t / 10) * 22) for t in range(0, 61)]
    for a, b in zip(pts, pts[1:]):
        page.draw_line(a, b)
    page.draw_line((L + 50, 560), (L + 270, 560))
    page.draw_line((L + 60, 570), (L + 60, 360))
    page.draw_line(pts[0], pts[45]); page.draw_line(pts[45], pts[60])
    page.insert_text((L + 52, 575), "O", fontname="helv", fontsize=9)
    page.insert_text((L + 238, 575), "A", fontname="helv", fontsize=9)
    page.insert_text((L + 60 + 45 * 3 + 4, pts[45][1] - 4), "P", fontname="helv", fontsize=9)
    page.insert_text((L, 640), "11.", fontname="korea", fontsize=13)
    _text(page, L + 22, 640, ["삼각형 OAP 의 넓이가 최대일 때,", "점 P 의 y 좌표는? [3점]", "① 6   ② 7   ③ 8   ④ 9   ⑤ 10"])
    # 오른쪽 단: 12번, 13번
    page.insert_text((R, 90), "12.", fontname="korea", fontsize=13)
    _text(page, R + 22, 90, ["∠OPA = 90° 일 때, 삼각형 OAP 의", "외접원의 둘레의 길이는? [3점]", "① 6π  ② 7π  ③ 8π  ④ 9π  ⑤ 10π"])
    page.insert_text((R, 500), "13.", fontname="korea", fontsize=13)
    _text(page, R + 22, 500, ["부등식 |x - 2| < 3 을 만족시키는", "정수 x 의 개수는? [3점]", "① 3   ② 4   ③ 5   ④ 6   ⑤ 7"])
    page.insert_text((W / 2 - 4, H - 40), "4", fontname="korea", fontsize=10)
    page.insert_text((L, H - 22), "이 문제지에 관한 저작권은 한국교육과정평가원에 있습니다.", fontname="korea", fontsize=8)
    doc.save(path)


if __name__ == "__main__":
    make(sys.argv[1])
