"""문제 이미지를 2022 개정 교육과정 단원으로 분류하고, 문제를 텍스트(LaTeX)로 옮겨 적는다."""

from __future__ import annotations

from typing import Any

from .curriculum import UNIT_IDS, curriculum_text, get_unit
from .llm import ask_json, image_block

SYSTEM = f"""너는 한국 고등학교 수학 교사이자 2022 개정 교육과정 전문가다.
모의고사 문제 이미지 한 장을 받으면 다음을 한다.

1. 문제를 그대로 옮겨 적는다(transcription). 수식은 LaTeX 로 $...$ 안에 쓰고, 5지선다면
   선택지를 ① ~ ⑤ 로 함께 적는다. 그림이 있으면 그림에 담긴 정보를 figure_description 에 자세히 적는다.
2. 아래 단원표에서 이 문제가 '주로' 다루는 중단원 하나(primary_unit_id)와, 풀이에 함께 쓰이는
   다른 중단원들(secondary_unit_ids, 없으면 빈 배열)을 고른다. 반드시 2022 개정 기준으로 판단한다.
   (예: 수열의 극한·급수는 미적분II, 지수·로그·삼각함수·수열은 대수, 다항함수의 미적분은 미적분I,
   경우의 수 기초는 공통수학1, 중복조합·이항정리는 확률과 통계, 행렬은 공통수학1)
3. 핵심 개념(key_concepts)과 이 문제를 푸는 핵심 접근법(solution_approach)을 쓴다.
   접근법은 '어떤 관찰에서 어떤 도구로 넘어가는지'가 드러나게 2~4문장으로 쓴다.
4. 직접 풀어서 정답(answer)과 풀이(solution)를 쓴다. 5지선다면 정답 번호(1~5)만, 단답형이면 값만 쓴다.
   이미지가 잘려 있거나 정보가 부족해 풀 수 없으면 answer 를 빈 문자열로 둔다.
5. 난이도(difficulty)를 1(기본)~5(최고난도, 킬러) 정수로 매긴다.

단원표 (코드: 과목 > 대단원 > 중단원)
{curriculum_text()}
"""

_UNIT_ENUM = {"type": "string", "enum": UNIT_IDS}

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "transcription": {"type": "string"},
        "figure_description": {"type": "string"},
        "question_type": {"type": "string", "enum": ["5지선다", "단답형", "서술형"]},
        "primary_unit_id": _UNIT_ENUM,
        "secondary_unit_ids": {"type": "array", "items": _UNIT_ENUM},
        "key_concepts": {"type": "array", "items": {"type": "string"}},
        "solution_approach": {"type": "string"},
        "answer": {"type": "string"},
        "solution": {"type": "string"},
        "difficulty": {"type": "integer"},
    },
    "required": [
        "transcription",
        "figure_description",
        "question_type",
        "primary_unit_id",
        "secondary_unit_ids",
        "key_concepts",
        "solution_approach",
        "answer",
        "solution",
        "difficulty",
    ],
    "additionalProperties": False,
}


def classify_problem(client: Any, png: bytes, *, exam_title: str = "", number: int | None = None) -> dict[str, Any]:
    hint = f"시험: {exam_title}\n" if exam_title else ""
    if number is not None:
        hint += f"문제 번호: {number}번\n"
    result = ask_json(
        client,
        system=SYSTEM,
        content=[image_block(png), {"type": "text", "text": hint + "이 문제를 분석해 JSON 으로 답하라."}],
        schema=SCHEMA,
        effort="high",
    )
    # 스키마로 보장되지만 방어적으로 확인
    unit = get_unit(result["primary_unit_id"])
    result["secondary_unit_ids"] = [u for u in result["secondary_unit_ids"] if u in UNIT_IDS and u != unit.unit_id]
    result["difficulty"] = min(5, max(1, int(result["difficulty"])))
    result["unit_label"] = unit.label
    return result
