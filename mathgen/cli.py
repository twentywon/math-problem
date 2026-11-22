"""명령줄 도구.

    python -m mathgen ingest 모의고사.pdf          # 자르기 + 단원 분류 + 저장
    python -m mathgen inbox [--watch]               # inbox/ 폴더의 PDF 를 모두 처리
    python -m mathgen split 모의고사.pdf            # 자르기만 (API 없이)
    python -m mathgen classify <시험ID|문제ID ...>   # (다시) 분류
    python -m mathgen generate <문제ID> --similar 2 --variant 1 --concept 2
    python -m mathgen list [--subject 대수]
    python -m mathgen html                          # library/index.html 다시 만들기
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .curriculum import SUBJECTS, UNITS
from .storage import Library, safe_name


def _client():
    from .llm import make_client

    return make_client()


# ---------------------------------------------------------------- 단계별 함수


def do_split(lib: Library, pdf: Path, exam_id: str | None, title: str | None, mode: str, dpi: int, client=None):
    from .pdf_split import split_pdf

    exam_id = safe_name(exam_id or pdf.stem)
    title = title or pdf.stem
    crops = split_pdf(pdf, lib.exam_dir(exam_id), mode=mode, dpi=dpi, client=client)
    pids = lib.add_exam(exam_id, title, pdf, crops)
    numbers = ", ".join(str(c.number) for c in crops)
    print(f"[자르기] {title}: 문제 {len(crops)}개 → {lib.exam_dir(exam_id)}")
    print(f"         번호: {numbers}")
    print(f"         검수용 이미지: {lib.exam_dir(exam_id) / '_check'}")
    gaps = [f"{a.number}→{b.number}" for a, b in zip(crops, crops[1:]) if b.section == a.section and b.number != a.number + 1]
    if gaps:
        print(f"  [주의] 번호가 건너뛴 곳이 있습니다: {', '.join(gaps)} — 검수용 이미지를 확인하세요.")
    return exam_id, pids


def do_classify(lib: Library, pids: list[str], client, force: bool = False, workers: int = 4):
    from .classify import classify_problem

    index = lib.load()
    todo = [p for p in pids if force or not index["problems"][p].get("classification")]
    if not todo:
        print("[분류] 새로 분류할 문제가 없습니다.")
        return

    def work(pid: str):
        meta = index["problems"][pid]
        png = lib.problem_image(meta).read_bytes()
        return pid, classify_problem(client, png, exam_title=meta["exam_title"], number=meta["number"])

    failed = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(work, pid) for pid in todo]
        for f in futures:
            try:
                pid, result = f.result()
            except Exception as e:  # 한 문제가 실패해도 나머지는 계속
                failed.append(str(e))
                continue
            meta = lib.set_classification(pid, result)
            print(f"[분류] {pid}: {result['unit_label']} (난이도 {result['difficulty']})")
    if failed:
        print(f"[분류] 실패 {len(failed)}건:", *failed, sep="\n  ", file=sys.stderr)


def _expand_ids(lib: Library, ids: list[str]) -> list[str]:
    index = lib.load()
    out: list[str] = []
    for i in ids:
        if i in index["problems"]:
            out.append(i)
        elif i in index["exams"]:
            out += sorted(p for p, m in index["problems"].items() if m["exam_id"] == i)
        else:
            raise SystemExit(f"찾을 수 없는 시험ID/문제ID: {i}  (python -m mathgen list 로 확인)")
    return out


# ---------------------------------------------------------------- 명령


def cmd_split(args):
    lib = Library(args.library)
    client = _client() if args.mode == "vision" else None
    do_split(lib, Path(args.pdf), args.exam_id, args.title, args.mode, args.dpi, client)
    lib.build_index_html()


def cmd_ingest(args):
    lib = Library(args.library)
    client = _client()
    _, pids = do_split(lib, Path(args.pdf), args.exam_id, args.title, args.mode, args.dpi, client)
    do_classify(lib, pids, client, workers=args.workers)
    print(f"[완료] {lib.build_index_html()}")


def cmd_inbox(args):
    lib = Library(args.library)
    inbox = Path(args.inbox)
    done = inbox / "done"
    inbox.mkdir(parents=True, exist_ok=True)
    client = None
    while True:
        pdfs = sorted(p for p in inbox.iterdir() if p.suffix.lower() == ".pdf")
        for pdf in pdfs:
            client = client or _client()
            try:
                _, pids = do_split(lib, pdf, None, None, args.mode, args.dpi, client)
                do_classify(lib, pids, client, workers=args.workers)
            except Exception as e:
                print(f"[오류] {pdf.name}: {e}", file=sys.stderr)
                continue
            done.mkdir(exist_ok=True)
            shutil.move(str(pdf), done / pdf.name)
        if pdfs:
            print(f"[완료] {lib.build_index_html()}")
        if not args.watch:
            if not pdfs:
                print(f"{inbox}/ 에 PDF 가 없습니다.")
            return
        time.sleep(args.interval)


def cmd_classify(args):
    lib = Library(args.library)
    index = lib.load()
    pids = list(index["problems"]) if args.all else _expand_ids(lib, args.ids)
    do_classify(lib, pids, _client(), force=args.force or not args.all, workers=args.workers)
    lib.build_index_html()


def cmd_generate(args):
    from .generate import generate_problems, verify_problem

    lib = Library(args.library)
    client = _client()
    counts = {"유사문제": args.similar, "변형문제": args.variant, "개념연계문제": args.concept}
    for pid in _expand_ids(lib, args.ids):
        meta = lib.load()["problems"][pid]
        if not meta.get("classification"):
            print(f"[생성] {pid} 는 아직 분류되지 않아 먼저 분류합니다.")
            do_classify(lib, [pid], client)
            meta = lib.load()["problems"][pid]
        png = lib.problem_image(meta).read_bytes()
        problems = generate_problems(client, meta, png, counts, extra_request=args.request or "")
        if not args.no_verify:
            with ThreadPoolExecutor(max_workers=args.workers) as ex:
                results = list(ex.map(lambda p: verify_problem(client, p), problems))
            for p, v in zip(problems, results):
                p["verification"] = v
        out = lib.save_generated(pid, problems)
        for p in problems:
            v = p.get("verification")
            status = "" if v is None else (" ✓ 검산 통과" if v["passed"] else " ✗ 검산 불일치 - 확인 필요")
            print(f"[생성] {pid} [{p['kind']}] {p['title']} (정답 {p['answer']}){status}")
        print(f"[생성] 결과: {out / 'generated.html'}")
    lib.build_index_html()


def cmd_list(args):
    lib = Library(args.library)
    index = lib.load()
    rows = sorted(index["problems"].values(), key=lambda m: (m.get("unit_id") or "~", m["exam_id"], m["order"]))
    for m in rows:
        c = m.get("classification")
        label = c["unit_label"] if c else "(미분류)"
        if args.subject and (not c or not label.startswith(args.subject)):
            continue
        if args.unit and m.get("unit_id") != args.unit:
            continue
        diff = f"난이도 {c['difficulty']}" if c else ""
        gen = f" 생성 {m['generated_count']}" if m.get("generated_count") else ""
        print(f"{m['id']:<32} {m['number']:>3}번  {label}  {diff}{gen}")


def cmd_units(args):
    for uid, u in UNITS.items():
        print(f"{uid:<10} {u.label}")


def cmd_html(args):
    print(Library(args.library).build_index_html())


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="mathgen", description="모의고사 PDF → 문제 이미지 → 단원 분류 → 유사·연계 문제 생성")
    ap.add_argument("--library", default="library", help="저장소 폴더 (기본: library)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def split_opts(p):
        p.add_argument("--mode", choices=["auto", "text", "vision"], default="auto", help="자르기 방식 (기본 auto)")
        p.add_argument("--dpi", type=int, default=200, help="문제 이미지 해상도 (기본 200)")

    p = sub.add_parser("split", help="PDF 를 문제별 이미지로 자르기만 한다")
    p.add_argument("pdf")
    p.add_argument("--exam-id")
    p.add_argument("--title")
    split_opts(p)
    p.set_defaults(func=cmd_split)

    p = sub.add_parser("ingest", help="자르기 + 단원 분류 + 저장")
    p.add_argument("pdf")
    p.add_argument("--exam-id", help="시험 ID (기본: 파일 이름)")
    p.add_argument("--title", help="시험 이름 (기본: 파일 이름)")
    p.add_argument("--workers", type=int, default=4)
    split_opts(p)
    p.set_defaults(func=cmd_ingest)

    p = sub.add_parser("inbox", help="inbox 폴더의 PDF 를 모두 처리하고 inbox/done 으로 옮긴다")
    p.add_argument("--inbox", default="inbox")
    p.add_argument("--watch", action="store_true", help="계속 감시하며 새 PDF 가 들어오면 처리")
    p.add_argument("--interval", type=int, default=10)
    p.add_argument("--workers", type=int, default=4)
    split_opts(p)
    p.set_defaults(func=cmd_inbox)

    p = sub.add_parser("classify", help="문제를 (다시) 단원 분류한다")
    p.add_argument("ids", nargs="*", help="시험ID 또는 문제ID")
    p.add_argument("--all", action="store_true", help="아직 분류되지 않은 모든 문제")
    p.add_argument("--force", action="store_true", help="이미 분류된 문제도 다시")
    p.add_argument("--workers", type=int, default=4)
    p.set_defaults(func=cmd_classify)

    p = sub.add_parser("generate", help="유사·변형·개념연계 문제를 만든다")
    p.add_argument("ids", nargs="+", help="문제ID (시험ID 를 주면 그 시험의 모든 문제)")
    p.add_argument("--similar", type=int, default=2, help="유사문제 개수 (기본 2)")
    p.add_argument("--variant", type=int, default=1, help="변형문제 개수 (기본 1)")
    p.add_argument("--concept", type=int, default=2, help="개념연계문제 개수 (기본 2)")
    p.add_argument("--request", help="추가 요청 (예: '난이도를 한 단계 낮춰서')")
    p.add_argument("--no-verify", action="store_true", help="독립 풀이 검산을 건너뛴다")
    p.add_argument("--workers", type=int, default=4)
    p.set_defaults(func=cmd_generate)

    p = sub.add_parser("list", help="저장된 문제 목록")
    p.add_argument("--subject", choices=SUBJECTS)
    p.add_argument("--unit", help="단원 코드 (python -m mathgen units 로 확인)")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("units", help="2022 개정 교육과정 단원 코드표")
    p.set_defaults(func=cmd_units)

    p = sub.add_parser("html", help="library/index.html 을 다시 만든다")
    p.set_defaults(func=cmd_html)

    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
