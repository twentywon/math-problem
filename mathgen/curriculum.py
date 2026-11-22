"""2022 개정 교육과정 수학과 단원 체계.

교육부 고시 제2022-33호 [별책 8] 수학과 교육과정의 내용 체계를 기준으로
모의고사 분류에 쓰이는 과목 > 대단원 > 중단원 3단계로 정리했다.

- 고등학교: 공통 과목(공통수학1, 공통수학2), 일반 선택(대수, 미적분I, 확률과 통계),
  진로 선택(미적분II, 기하)
- 중학교: 고1 3월 모의고사처럼 중학 과정을 묻는 문제를 위해 영역별로 포함

각 중단원에는 고유 코드(unit_id)가 붙는다. 예: "CM1-2-1" = 공통수학1 > 방정식과 부등식 > 복소수와 이차방정식
"""

from __future__ import annotations

from dataclasses import dataclass

# (과목 코드, 과목명, [(대단원명, [중단원명, ...]), ...])
_TREE: list[tuple[str, str, list[tuple[str, list[str]]]]] = [
    (
        "MS",
        "중학교 수학",
        [
            ("수와 연산", ["소인수분해", "정수와 유리수", "유리수와 순환소수", "제곱근과 실수"]),
            (
                "변화와 관계",
                [
                    "문자의 사용과 식의 계산",
                    "일차방정식",
                    "좌표평면과 그래프",
                    "연립일차방정식",
                    "일차부등식",
                    "일차함수와 그래프",
                    "다항식의 곱셈과 인수분해",
                    "이차방정식",
                    "이차함수와 그래프",
                ],
            ),
            (
                "도형과 측정",
                [
                    "기본 도형과 작도",
                    "평면도형과 입체도형",
                    "삼각형과 사각형의 성질",
                    "도형의 닮음",
                    "피타고라스 정리",
                    "삼각비",
                    "원의 성질",
                ],
            ),
            ("자료와 가능성", ["자료의 정리와 해석", "경우의 수와 확률", "대푯값과 산포도", "상관관계"]),
        ],
    ),
    (
        "CM1",
        "공통수학1",
        [
            ("다항식", ["다항식의 연산", "항등식과 나머지정리", "인수분해"]),
            ("방정식과 부등식", ["복소수와 이차방정식", "이차방정식과 이차함수", "여러 가지 방정식과 부등식"]),
            ("경우의 수", ["합의 법칙과 곱의 법칙", "순열과 조합"]),
            ("행렬", ["행렬과 그 연산"]),
        ],
    ),
    (
        "CM2",
        "공통수학2",
        [
            ("도형의 방정식", ["평면좌표", "직선의 방정식", "원의 방정식", "도형의 이동"]),
            ("집합과 명제", ["집합", "명제"]),
            ("함수와 그래프", ["함수", "유리함수와 무리함수"]),
        ],
    ),
    (
        "ALG",
        "대수",
        [
            ("지수함수와 로그함수", ["지수와 로그", "지수함수와 로그함수"]),
            ("삼각함수", ["삼각함수", "사인법칙과 코사인법칙"]),
            ("수열", ["등차수열과 등비수열", "수열의 합", "수학적 귀납법"]),
        ],
    ),
    (
        "CAL1",
        "미적분I",
        [
            ("함수의 극한과 연속", ["함수의 극한", "함수의 연속"]),
            ("미분", ["미분계수와 도함수", "도함수의 활용"]),
            ("적분", ["부정적분과 정적분", "정적분의 활용"]),
        ],
    ),
    (
        "PS",
        "확률과 통계",
        [
            ("경우의 수", ["순열과 조합", "이항정리"]),
            ("확률", ["확률의 뜻과 활용", "조건부확률"]),
            ("통계", ["확률분포", "통계적 추정"]),
        ],
    ),
    (
        "CAL2",
        "미적분II",
        [
            ("수열의 극한", ["수열의 극한", "급수"]),
            ("미분법", ["여러 가지 함수의 미분", "여러 가지 미분법", "도함수의 활용"]),
            ("적분법", ["여러 가지 적분법", "정적분의 활용"]),
        ],
    ),
    (
        "GEO",
        "기하",
        [
            ("이차곡선", ["이차곡선", "이차곡선과 직선"]),
            ("공간도형과 공간좌표", ["직선과 평면", "정사영", "공간좌표"]),
            ("벡터", ["벡터의 연산", "벡터의 성분과 내적"]),
        ],
    ),
]


@dataclass(frozen=True)
class Unit:
    unit_id: str
    subject_index: int
    subject: str
    chapter_index: int
    chapter: str
    section_index: int
    section: str

    @property
    def label(self) -> str:
        return f"{self.subject} > {self.chapter} > {self.section}"

    @property
    def path_parts(self) -> tuple[str, str, str]:
        """저장용 폴더 이름 3단계 (정렬이 교육과정 순서대로 되도록 번호를 붙인다)."""
        return (
            f"{self.subject_index:02d}_{self.subject}",
            f"{self.chapter_index:02d}_{self.chapter}",
            f"{self.section_index:02d}_{self.section}",
        )


def _build() -> dict[str, Unit]:
    units: dict[str, Unit] = {}
    for si, (code, subject, chapters) in enumerate(_TREE):
        for ci, (chapter, sections) in enumerate(chapters, start=1):
            for ki, section in enumerate(sections, start=1):
                uid = f"{code}-{ci}-{ki}"
                units[uid] = Unit(uid, si, subject, ci, chapter, ki, section)
    return units


UNITS: dict[str, Unit] = _build()
UNIT_IDS: list[str] = list(UNITS)
SUBJECTS: list[str] = [s for _, s, _ in _TREE]


def get_unit(unit_id: str) -> Unit:
    try:
        return UNITS[unit_id]
    except KeyError as e:
        raise ValueError(f"알 수 없는 단원 코드: {unit_id}") from e


def curriculum_text() -> str:
    """프롬프트에 넣을 단원 목록 (코드: 과목 > 대단원 > 중단원)."""
    lines = []
    for code, subject, chapters in _TREE:
        lines.append(f"[{subject}]")
        for ci, (chapter, sections) in enumerate(chapters, start=1):
            for ki, section in enumerate(sections, start=1):
                lines.append(f"  {code}-{ci}-{ki}: {subject} > {chapter} > {section}")
    return "\n".join(lines)
