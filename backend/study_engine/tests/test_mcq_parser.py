"""
Tests for the MCQ payload parser + route response shape.

Covers the failure modes called out in the PR-A prompt:
  • Malformed JSON
  • Missing or invalid correctOptionId
  • Duplicate option ids
  • Regression: /study/mcq/generate must never serialise correctOptionId

Run from the repo root with:
    pytest backend/study_engine/tests/test_mcq_parser.py -v
"""

import os
import sys
import json
import pytest

# Make `from backend...` imports work no matter where pytest is invoked from.
_HERE        = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from backend.study_engine.study_llm import parse_mcq_payload, strip_correct_option


# ─────────────────────────────────────────────
# parse_mcq_payload
# ─────────────────────────────────────────────


VALID_PAYLOAD = json.dumps({
    "questions": [
        {
            "id": "q1",
            "question": "What is $2 + 2$?",
            "questionAr": "كم يساوي $2 + 2$؟",
            "options": [
                {"id": "a", "label": "$3$",  "labelAr": "$3$"},
                {"id": "b", "label": "$4$",  "labelAr": "$4$"},
                {"id": "c", "label": "$5$",  "labelAr": "$5$"},
                {"id": "d", "label": "$22$", "labelAr": "$22$"},
            ],
            "correctOptionId": "b",
            "explanation": "Basic addition.",
            "explanationAr": "جمع أساسي.",
            "hint": "Just add.",
            "hintAr": "اجمع.",
        }
    ]
})


def test_parses_well_formed_payload():
    out = parse_mcq_payload(VALID_PAYLOAD, expected_count=1)
    assert len(out) == 1
    q = out[0]
    assert q["question"] == "What is $2 + 2$?"
    assert q["correctOptionId"] == "b"
    assert len(q["options"]) == 4
    assert q["options"][1]["id"] == "b"


def test_strips_json_code_fence_wrapper():
    fenced = "```json\n" + VALID_PAYLOAD + "\n```"
    out = parse_mcq_payload(fenced, expected_count=1)
    assert len(out) == 1
    assert out[0]["correctOptionId"] == "b"


def test_rejects_invalid_json():
    with pytest.raises(ValueError):
        parse_mcq_payload("this is not json", expected_count=1)


def test_rejects_empty_payload():
    with pytest.raises(ValueError):
        parse_mcq_payload("", expected_count=1)


def test_rejects_non_object_root():
    with pytest.raises(ValueError):
        parse_mcq_payload(json.dumps(["not", "an", "object"]), expected_count=1)


def test_rejects_missing_questions_field():
    with pytest.raises(ValueError):
        parse_mcq_payload(json.dumps({"foo": "bar"}), expected_count=1)


def test_rejects_empty_questions_list():
    with pytest.raises(ValueError):
        parse_mcq_payload(json.dumps({"questions": []}), expected_count=1)


def test_recovers_from_numeric_correct_option_id():
    payload = json.dumps({
        "questions": [{
            "id": "q1",
            "question": "Q?",
            "options": [
                {"id": "a", "label": "A"},
                {"id": "b", "label": "B"},
                {"id": "c", "label": "C"},
                {"id": "d", "label": "D"},
            ],
            "correctOptionId": "2",  # 1-indexed numeric → 'b'
            "explanation": "x",
        }]
    })
    out = parse_mcq_payload(payload, expected_count=1)
    assert out[0]["correctOptionId"] == "b"


def test_recovers_from_uppercase_correct_option_id():
    payload = json.dumps({
        "questions": [{
            "id": "q1",
            "question": "Q?",
            "options": [
                {"id": "a", "label": "A"},
                {"id": "b", "label": "B"},
                {"id": "c", "label": "C"},
                {"id": "d", "label": "D"},
            ],
            "correctOptionId": "C",
            "explanation": "x",
        }]
    })
    out = parse_mcq_payload(payload, expected_count=1)
    assert out[0]["correctOptionId"] == "c"


def test_drops_questions_with_unresolvable_correct_option():
    payload = json.dumps({
        "questions": [
            {
                "id": "good",
                "question": "Good?",
                "options": [
                    {"id": "a", "label": "A"},
                    {"id": "b", "label": "B"},
                    {"id": "c", "label": "C"},
                    {"id": "d", "label": "D"},
                ],
                "correctOptionId": "a",
                "explanation": "x",
            },
            {
                "id": "bad",
                "question": "Bad?",
                "options": [
                    {"id": "a", "label": "A"},
                    {"id": "b", "label": "B"},
                    {"id": "c", "label": "C"},
                    {"id": "d", "label": "D"},
                ],
                "correctOptionId": "z",   # invalid id
                "explanation": "no recoverable signal",
            },
        ]
    })
    out = parse_mcq_payload(payload, expected_count=2)
    assert len(out) == 1
    assert out[0]["id"] == "good"


def test_renormalises_duplicate_option_ids():
    # The LLM occasionally repeats 'a' for every option. We force positional
    # ids ('a','b','c','d') so the resulting test is still usable.
    payload = json.dumps({
        "questions": [{
            "id": "q1",
            "question": "Q?",
            "options": [
                {"id": "a", "label": "A1"},
                {"id": "a", "label": "A2"},
                {"id": "a", "label": "A3"},
                {"id": "a", "label": "A4"},
            ],
            "correctOptionId": "b",   # the position the LLM "meant"
            "explanation": "x",
        }]
    })
    out = parse_mcq_payload(payload, expected_count=1)
    assert len(out) == 1
    assert [o["id"] for o in out[0]["options"]] == ["a", "b", "c", "d"]
    assert out[0]["correctOptionId"] == "b"


def test_pads_when_fewer_than_four_options():
    payload = json.dumps({
        "questions": [{
            "id": "q1",
            "question": "Q?",
            "options": [
                {"id": "a", "label": "A"},
                {"id": "b", "label": "B"},
            ],
            "correctOptionId": "a",
            "explanation": "x",
        }]
    })
    out = parse_mcq_payload(payload, expected_count=1)
    assert len(out[0]["options"]) == 4
    assert [o["id"] for o in out[0]["options"]] == ["a", "b", "c", "d"]
    # Padded slots get blank labels, NOT the correct one — so they're inert.
    assert out[0]["options"][2]["label"] == ""
    assert out[0]["options"][3]["label"] == ""


def test_respects_expected_count_truncation():
    payload = json.dumps({
        "questions": [
            {
                "id":   f"q{i}",
                "question": f"Q {i}?",
                "options": [
                    {"id": "a", "label": "A"},
                    {"id": "b", "label": "B"},
                    {"id": "c", "label": "C"},
                    {"id": "d", "label": "D"},
                ],
                "correctOptionId": "a",
                "explanation": "x",
            }
            for i in range(10)
        ]
    })
    out = parse_mcq_payload(payload, expected_count=5)
    assert len(out) == 5
    assert [q["id"] for q in out] == ["q0", "q1", "q2", "q3", "q4"]


# ─────────────────────────────────────────────
# strip_correct_option (used by the route)
# ─────────────────────────────────────────────


def test_strip_correct_option_removes_answer_fields():
    full = parse_mcq_payload(VALID_PAYLOAD, expected_count=1)[0]
    safe = strip_correct_option(full)
    assert "correctOptionId" not in safe
    assert "explanation"      not in safe
    assert "explanationAr"    not in safe
    # User-facing fields are preserved
    assert safe["question"]   == full["question"]
    assert safe["questionAr"] == full["questionAr"]
    assert len(safe["options"]) == 4
    assert safe["hint"]   == full["hint"]
    assert safe["hintAr"] == full["hintAr"]


# ─────────────────────────────────────────────
# Regression: /study/mcq/generate must NEVER leak correctOptionId
# ─────────────────────────────────────────────
#
# We monkey-patch `_mcq_generate` (the route's bound symbol) so the test runs
# without a real LLM key. The assertion is on the route's actual response —
# this is the contract reviewers will pin on.


@pytest.fixture
def app_client(monkeypatch):
    """A TestClient bound to a backend.app instance with the LLM stubbed out."""
    from backend import app as app_module

    fake_full = {
        "test_id": "mcq-test-id",
        "branch":  "algebra",
        "difficulty": "medium",
        "questions": [
            {
                "id":              "q1",
                "question":        "Solve $x + 1 = 2$",
                "questionAr":      "أوجد قيمة $x$ من $x + 1 = 2$",
                "options": [
                    {"id": "a", "label": "$0$", "labelAr": "$0$"},
                    {"id": "b", "label": "$1$", "labelAr": "$1$"},
                    {"id": "c", "label": "$2$", "labelAr": "$2$"},
                    {"id": "d", "label": "$3$", "labelAr": "$3$"},
                ],
                "correctOptionId": "b",        # SHOULD be stripped by the route
                "explanation":     "Trivial",  # SHOULD also be stripped
                "explanationAr":   "تافه",
                "hint":            "Subtract 1",
                "hintAr":          "اطرح 1",
            }
        ],
    }

    def fake_generate(branch, difficulty, count, source_question=""):
        # Mimic what study_tools.generate_mcq returns AFTER stripping. We
        # intentionally leave a "correctOptionId" key on the question to
        # prove the route's defence-in-depth strip still scrubs it.
        return {
            "test_id":    fake_full["test_id"],
            "branch":     branch,
            "difficulty": difficulty,
            "questions": [
                {**q, "correctOptionId": q["correctOptionId"]}  # leaky on purpose
                for q in fake_full["questions"]
            ],
        }

    monkeypatch.setattr(app_module, "_mcq_generate", fake_generate)

    from fastapi.testclient import TestClient
    return TestClient(app_module.app)


def test_route_strips_correct_option_id_even_if_tool_leaks_it(app_client):
    res = app_client.post("/study/mcq/generate", json={
        "branch": "algebra",
        "difficulty": "medium",
        "count": 1,
    })
    assert res.status_code == 200, res.text
    payload = res.json()
    assert "questions" in payload
    body = json.dumps(payload).lower()
    # Belt-and-suspenders: neither key name and neither value should appear
    # in the wire response.
    assert "correctoptionid"   not in body
    assert "correct_option_id" not in body
    # Explanation must also stay server-side until /mcq/check runs.
    for q in payload["questions"]:
        assert "correctOptionId"  not in q
        assert "correct_option_id" not in q
        assert "explanation"      not in q
        assert "explanationAr"    not in q
