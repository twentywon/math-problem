"""Claude API 호출 공통부.

- 모델: 기본 claude-opus-5-5 (환경변수 MATHGEN_MODEL 로 변경 가능)
- 응답 형식: structured outputs(JSON Schema)로 고정해 파싱 실패를 막는다.
- 안전 분류기가 요청을 거절하는 경우를 대비해 서버측 fallback("default")을 켠다.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

import anthropic

DEFAULT_MODEL = os.environ.get("MATHGEN_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMError(RuntimeError):
    pass


def make_client() -> anthropic.Anthropic:
    # ANTHROPIC_API_KEY 또는 `ant auth login` 프로필을 자동으로 사용한다.
    return anthropic.Anthropic(max_retries=4)


def image_block(png_bytes: bytes) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.standard_b64encode(png_bytes).decode("ascii"),
        },
    }


def ask_json(
    client: Any,
    *,
    system: str,
    content: list[dict[str, Any]],
    schema: dict[str, Any],
    effort: str = "high",
    model: str | None = None,
    max_tokens: int = 64000,
) -> dict[str, Any]:
    """이미지/텍스트를 보내고 schema 에 맞는 JSON 객체를 돌려받는다."""
    with client.beta.messages.stream(
        model=model or DEFAULT_MODEL,
        max_tokens=max_tokens,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        thinking={"type": "adaptive"},
        output_config={
            "effort": effort,
            "format": {"type": "json_schema", "schema": schema},
        },
        # 시스템 프롬프트(단원표 등)는 매 호출 동일하므로 캐시한다.
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        details = getattr(message, "stop_details", None)
        category = getattr(details, "category", None) if details else None
        raise LLMError(f"모델이 요청을 거절했습니다 (category={category})")
    if message.stop_reason == "max_tokens":
        raise LLMError("응답이 max_tokens 에서 잘렸습니다")

    text = next((b.text for b in message.content if b.type == "text"), None)
    if text is None:
        raise LLMError(f"텍스트 응답이 없습니다 (stop_reason={message.stop_reason})")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"JSON 파싱 실패: {e}") from e
