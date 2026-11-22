"""원본 문제를 바탕으로 유사 문제 / 변형 문제 / 개념·접근법 연계 문제를 만들고 검산한다."""

from __future__ import annotations

import re
from typing import Any

from .curriculum import UNIT_IDS, curriculum_text, get_unit
from .llm import ask_json, image_block

KINDS = {
    "유사문제": "원본과 구조·풀이 흐름이 같고 수치·함수·조건만 바꾼 문제. 원본을 푼 학생이 같은 방법으로 풀 수 있어야 한다.",
    "변형문제": "원본과 같은 단원·같은 핵심 개념을 쓰지만 묻는 것이나 조건의 방향을 바꿔 한 단계 다른 사고가 필요한 문제 "
    "(예: 역으로 묻기, 조건 추가, 미지수 위치 바꾸기).",
    "개념연계문제": "원본의 핵심 개념이나 접근법(예: 대칭성 이용, 그래프 개형 추론, 경우 나누기, 치환)을 "
    "다른 상황이나 다른 단원에 적용하는 문제. 겉모습은 달라도 같은 아이디어로 풀린다.",
}

SYSTEM = f"""너는 한국 수능·모의고사 출제 경험이 많은 수학 교사다. 2022 개정 교육과정 범위 안에서 문제를 만든다.

규칙
- 모든 문제는 교육과정 범위를 벗어나지 않아야 하고, 조건이 모자라거나 넘치지 않아 답이 하나로 정해져야 한다.
- 수식은 LaTeX 로 $...$ (줄 수식은 $$...$$) 안에 쓴다.
- 5지선다면 choices 에 선택지 5개를 수식 포함 문자열로 넣고 answer 에는 정답 번호(1~5)만 쓴다.
  단답형이면 choices 는 빈 배열, answer 는 값만 쓴다(수능 단답형처럼 0 이상 999 이하의 정수가 되도록 하는 것을 권장).
- 그림이 꼭 필요하면 figure_description 에 그림을 그릴 수 있을 만큼 자세히 설명하되, 문제 본문만으로도 풀 수 있게 조건을 글로 적는다.
  그림이 없으면 빈 문자열.
- 문제를 다 만든 뒤 스스로 끝까지 풀어서 정답과 풀이(solution)를 확인한다. 계산이 맞지 않으면 문제를 고친다.
- relation_to_original 에는 원본과 무엇이 같고 무엇이 다른지, 어떤 개념·접근법을 공유하는지 쓴다.
- unit_id 는 아래 단원표의 코드 중 새 문제가 주로 다루는 중단원.

문제 유형
""" + "\n".join(f"- {k}: {v}" for k, v in KINDS.items()) + f"""

단원표 (코드: 과목 > 대단원 > 중단원)
{curriculum_text()}
"""

_PROBLEM = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": list(KINDS)},
        "title": {"type": "string"},
        "statement": {"type": "string"},
        "choices": {"type": "array", "items": {"type": "string"}},
        "figure_description": {"type": "string"},
        "answer": {"type": "string"},
        "solution": {"type": "string"},
        "shared_concepts": {"type": "array", "items": {"type": "string"}},
        "relation_to_original": {"type": "string"},
        "unit_id": {"type": "string", "enum": UNIT_IDS},
        "difficulty": {"type": "integer"},
    },
    "required": [
        "kind",
        "title",
        "statement",
        "choices",
        "figure_description",
        "answer",
        "solution",
        "shared_concepts",
        "relation_to_original",
        "unit_id",
        "difficulty",
    ],
    "additionalProperties": False,
}

SCHEMA = {
    "type": "object",
    "properties": {"problems": {"type": "array", "items": _PROBLEM}},
    "required": ["problems"],
    "additionalProperties": False,
}

VERIFY_SYSTEM = """너는 꼼꼼한 수학 검토자다. 주어진 문제를 처음 보는 학생처럼 직접 풀어라.
- answer: 5지선다면 정답 번호(1~5)만, 단답형이면 값만.
- well_posed: 조건이 모순되지 않고 답이 하나로 정해지며 교육과정 범위 안이면 true.
- issues: 오류, 모호한 표현, 답이 여러 개이거나 없는 문제 등을 구체적으로. 없으면 빈 문자열.
- solution_brief: 핵심 풀이를 3~6줄로."""

VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "well_posed": {"type": "boolean"},
        "issues": {"type": "string"},
        "solution_brief": {"type": "string"},
    },
    "required": ["answer", "well_posed", "issues", "solution_brief"],
    "additionalProperties": False,
}

_CIRCLED = {"①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5"}


def normalize_answer(a: str) -> str:
    a = a.strip()
    for k, v in _CIRCLED.items():
        a = a.replace(k, v)
    a = re.sub(r"[\s$]|\\[,;!]|\\text\{[^}]*\}|번$", "", a)
    a = a.replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")
    return a.rstrip(".")


def _original_text(meta: dict[str, Any]) -> str:
    c = meta.get("classification") or {}
    parts = [f"[원본 문제] {meta.get('exam_title', '')} {meta.get('number', '')}번"]
    if c:
        parts += [
            f"단원: {c.get('unit_label', '')}",
            f"문제 텍스트:\n{c.get('transcription', '')}",
            f"그림 설명: {c.get('figure_description', '') or '없음'}",
            f"핵심 개념: {', '.join(c.get('key_concepts', []))}",
            f"핵심 접근법: {c.get('solution_approach', '')}",
            f"정답: {c.get('answer', '')}",
            f"풀이:\n{c.get('solution', '')}",
        ]
    return "\n".join(parts)


def generate_problems(
    client: Any,
    meta: dict[str, Any],
    png: bytes | None,
    counts: dict[str, int],
    extra_request: str = "",
) -> list[dict[str, Any]]:
    wanted = ", ".join(f"{k} {n}개" for k, n in counts.items() if n > 0)
    if not wanted:
        return []
    request = (
        f"{_original_text(meta)}\n\n"
        f"위 원본 문제를 바탕으로 다음을 만들어라: {wanted}. 각 문제의 kind 를 정확히 표시하라."
    )
    if extra_request:
        request += f"\n추가 요청: {extra_request}"
    content: list[dict[str, Any]] = []
    if png:
        content.append(image_block(png))
    content.append({"type": "text", "text": request})
    data = ask_json(client, system=SYSTEM, content=content, schema=SCHEMA, effort="high")
    problems = data["problems"]
    for p in problems:
        p["difficulty"] = min(5, max(1, int(p["difficulty"])))
        p["unit_label"] = get_unit(p["unit_id"]).label
    return problems


def problem_as_text(p: dict[str, Any]) -> str:
    text = p["statement"]
    if p.get("figure_description"):
        text += f"\n\n[그림 설명] {p['figure_description']}"
    if p.get("choices"):
        marks = "①②③④⑤"
        text += "\n\n" + "  ".join(f"{marks[i] if i < 5 else i + 1} {c}" for i, c in enumerate(p["choices"]))
    return text


def verify_problem(client: Any, p: dict[str, Any]) -> dict[str, Any]:
    """출제와 별개의 호출로 새 문제를 다시 풀어 정답이 일치하는지 확인한다."""
    kind = "5지선다" if p.get("choices") else "단답형"
    result = ask_json(
        client,
        system=VERIFY_SYSTEM,
        content=[{"type": "text", "text": f"({kind})\n{problem_as_text(p)}"}],
        schema=VERIFY_SCHEMA,
        effort="high",
    )
    result["answer_match"] = normalize_answer(result["answer"]) == normalize_answer(p["answer"])
    result["passed"] = bool(result["answer_match"] and result["well_posed"])
    return result
