#!/usr/bin/env python3
"""Alternate exact before/after checkouts in native Canvas on the same host.

Serve both checkouts with fresh Vite processes. Uses the shared visual harness;
analysis happens before timing, and exports/encoding are deliberately separate.
Outputs raw per-case observations, medians, budget failures and regressions.
A regression is >25% AND >0.3 ms in p95, to avoid flagging timer noise. Changed
geometry may justify a regression; report it rather than hiding it in averages.
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
from pathlib import Path
from statistics import median

from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location("visual_harness", Path(__file__).with_name("verify-visual-styles.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before-url", required=True)
    parser.add_argument("--after-url", required=True)
    parser.add_argument("--output", default="/tmp/pulseframe-performance-regression.json")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--cases", help="comma-separated audio cases; defaults to all seven")
    args = parser.parse_args()
    if not 1 <= args.rounds <= 7:
        parser.error("--rounds must be between 1 and 7")
    errors, observations = [], []
    with sync_playwright() as playwright:
        chromium_path = Path("/usr/bin/chromium")
        browser = playwright.chromium.launch(executable_path=str(chromium_path) if chromium_path.exists() else None, headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"])
        contexts, pages, sessions = {}, {}, {}
        for version, url in [("before", args.before_url), ("after", args.after_url)]:
            context = browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
            page = context.new_page()
            page.on("pageerror", lambda error, version=version: errors.append({"version": version, "error": str(error)}))
            page.goto(url, wait_until="networkidle", timeout=120000)
            setup = page.evaluate(harness.SETUP_JS)
            contexts[version], pages[version] = context, page
            sessions[version] = context.new_cdp_session(page)
        # All six styles use default isolated and full compositing. Actual curated
        # looks are measured too, since enabling particles changes their cost.
        modes, cases = setup["modes"], setup["audioNames"]
        if args.cases:
            requested = args.cases.split(",")
            if any(case not in cases for case in requested):
                parser.error("unknown audio case")
            cases = requested
        for device, rate in [("desktop", 1), ("cpu4xSimulation", 4)]:
            for session in sessions.values():
                session.send("Emulation.setCPUThrottlingRate", {"rate": rate})
            for round_index in range(args.rounds):
                order = ["before", "after"] if round_index % 2 == 0 else ["after", "before"]
                for profile, compositing, selected_cases in [
                    ("default", False, cases), ("default", True, cases),
                    ("builtin", True, [case for case in ["impulse", "high_intensity"] if case in cases]),
                ]:
                    for mode in modes:
                        # Release previous groups' unused canvases before comparing
                        # short pairs. Neither GC nor tab activation is timed.
                        for session in sessions.values():
                            session.send("HeapProfiler.collectGarbage")
                        for case in selected_cases:
                            for version in order:
                                page = pages[version]
                                page.bring_to_front()
                                stats = page.evaluate("a => window.__styleFinal.renderRun(...a)",
                                    [mode, case, compositing, 1280, 720, profile])
                                observations.append(dict(version=version, device=device, round=round_index,
                                    profile=profile, compositing=compositing, mode=mode, case=case, **stats))
                print(f"Completed {device} round {round_index + 1}: paired cases", flush=True)
        for session in sessions.values():
            session.detach()
        browser.close()
    comparisons = []
    keys = sorted({(row["device"], row["profile"], row["compositing"], row["mode"], row["case"])
                   for row in observations})
    for device, profile, compositing, mode, case in keys:
        subset = [row for row in observations if
                  (row["device"], row["profile"], row["compositing"], row["mode"], row["case"]) ==
                  (device, profile, compositing, mode, case)]
        before, after = [median(row["p95Ms"] for row in subset if row["version"] == version)
                         for version in ["before", "after"]]
        delta = after - before
        budget = 6 if device == "desktop" else 12
        comparisons.append(dict(device=device, profile=profile, compositing=compositing, mode=mode,
            case=case, beforeP95Ms=before, afterP95Ms=after, deltaMs=delta,
            ratio=after / before if before else None,
            regression=delta > 0.3 and after > before * 1.25,
            afterWithinBudget=None if compositing else after <= budget, budgetMs=None if compositing else budget))
    report = dict(rounds=args.rounds, canvas={"width":1280,"height":720},
        method="Median per-case p95 of short alternating before/after pairs, tab activated before each run and explicit GC between mode/profile groups; 30 warm-up/120 measured frames per run; native Canvas API submission, no GPU readback, analysis or encoding; same desktop Chromium host. CPU4x is a simulation, not physical mobile.",
        audioCases=cases, observations=observations, comparisons=comparisons,
        regressions=[row for row in comparisons if row["regression"]],
        budgetFailures=[row for row in comparisons if row["afterWithinBudget"] is False], errors=errors)
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
    with Path(args.output).with_suffix(".csv").open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(comparisons[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(comparisons)
    print(json.dumps({"output":args.output,"comparisons":len(comparisons),
        "regressions":len(report["regressions"]),"budgetFailures":len(report["budgetFailures"]),"errors":errors}))
    if errors or report["budgetFailures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
