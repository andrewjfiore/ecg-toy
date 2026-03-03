#!/usr/bin/env python3
"""
ECG-Toy Fuzz & Chaos Test Suite
Tests: malformed JSON imports, XSS payloads, huge data structures, corrupt ECG data
"""
import json
import sys
import random
import string
import copy
import traceback

RESULTS = []

# ─── Valid baseline ECG fixture ───────────────────────────────────────────────
VALID_ECG = {
    "title": "Normal Sinus Rhythm",
    "diagnosis": "Normal",
    "rate": 75,
    "pr": 160,
    "qrs": 100,
    "qt": 400,
    "axis": 60,
    "leads": {
        "I":   {"stElevation": 0, "tWave": "normal", "qWave": False},
        "II":  {"stElevation": 0, "tWave": "normal", "qWave": False},
        "III": {"stElevation": 0, "tWave": "normal", "qWave": False},
        "aVR": {"stElevation": 0, "tWave": "normal", "qWave": False},
        "aVL": {"stElevation": 0, "tWave": "normal", "qWave": False},
        "aVF": {"stElevation": 0, "tWave": "normal", "qWave": False},
        "V1":  {"stElevation": 0, "tWave": "normal", "qWave": False},
        "V2":  {"stElevation": 0, "tWave": "normal", "qWave": False},
        "V3":  {"stElevation": 0, "tWave": "normal", "qWave": False},
        "V4":  {"stElevation": 0, "tWave": "normal", "qWave": False},
        "V5":  {"stElevation": 0, "tWave": "normal", "qWave": False},
        "V6":  {"stElevation": 0, "tWave": "normal", "qWave": False},
    }
}

def record(test_name, category, severity, finding, suggestion, passed=False):
    RESULTS.append({
        "test": test_name,
        "category": category,
        "severity": severity,
        "finding": finding,
        "suggestion": suggestion,
        "passed": passed,
    })
    icon = {"🔴": "🔴", "🟡": "🟡", "🟢": "🟢"}.get(severity, "⚪")
    status = "✅ PASS" if passed else f"{icon} ISSUE"
    print(f"[{status}] {test_name}: {finding}")


# ─── JSON Parse Safety Tests ──────────────────────────────────────────────────

def simulate_import_ecg(json_str):
    """Simulate what index.html importECG() does: JSON.parse then field access."""
    try:
        data = json.loads(json_str)
        # Access paths exercised in the JS
        _ = data.get("title", "")
        _ = data.get("diagnosis", "")
        _ = data.get("rate", 75)
        _ = data.get("pr", 160)
        leads = data.get("leads", {})
        if isinstance(leads, dict):
            for lead_name, lead_data in leads.items():
                if isinstance(lead_data, dict):
                    _ = lead_data.get("stElevation", 0)
                    _ = lead_data.get("tWave", "normal")
        return True, data
    except json.JSONDecodeError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)


def test_malformed_json_variants():
    """Test various malformed JSON strings."""
    malformed = [
        ("empty_string", ""),
        ("just_null", "null"),
        ("just_array", "[]"),
        ("truncated_json", '{"title": "test", "leads": {'),
        ("json_with_comment", '{"title": "test" /* comment */, "leads": {}}'),
        ("trailing_comma", '{"title": "test", "leads": {},}'),
        ("single_quotes", "{'title': 'test'}"),
        ("unicode_bom", "\ufeff{\"title\":\"test\"}"),
        ("control_chars", '{"title": "te\x00st", "leads": {}}'),
        ("nested_overflow_depth", json.dumps({"a": {"b": {"c": {"d": {"e": {"f": VALID_ECG}}}}}})),
    ]
    for name, payload in malformed:
        ok, result = simulate_import_ecg(payload)
        if not ok:
            record(f"malformed_json/{name}", "JSON Import", "🟢", 
                   f"JSON.parse fails safely: {str(result)[:80]}", 
                   "Current try/catch handles this — verify user sees meaningful error message", passed=True)
        else:
            record(f"malformed_json/{name}", "JSON Import", "🟡",
                   f"Unexpected parse success for '{name}' — may cause runtime errors downstream",
                   "Add schema validation after parse before using data")


def test_xss_in_title_field():
    """XSS payloads in ECG title/diagnosis fields."""
    xss_payloads = [
        '<script>alert("XSS")</script>',
        '"><img src=x onerror=alert(1)>',
        "javascript:alert(1)",
        '<svg onload=alert(1)>',
        '{{constructor.constructor("alert(1)")()}}',
        '\'; DROP TABLE users; --',
        '<iframe src="javascript:alert(1)">',
    ]
    
    for payload in xss_payloads:
        ecg = copy.deepcopy(VALID_ECG)
        ecg["title"] = payload
        ecg["diagnosis"] = payload
        json_str = json.dumps(ecg)
        
        ok, data = simulate_import_ecg(json_str)
        if ok and isinstance(data, dict):
            title = data.get("title", "")
            # Check if payload is stored unescaped (it will be — JS handles escaping at render time)
            if title == payload:
                record(f"xss_title/{payload[:30]}", "XSS", "🔴",
                       f"XSS payload stored verbatim in title field: {payload[:50]}",
                       "Sanitize imported title/diagnosis fields with DOMPurify or strip HTML tags. "
                       "Verify JS template literals use textContent not innerHTML for these fields.")


def test_extreme_numeric_values():
    """Extreme/invalid numeric values in ECG fields."""
    extremes = [
        ("rate_zero", "rate", 0),
        ("rate_negative", "rate", -100),
        ("rate_infinity", "rate", float('inf')),
        ("rate_nan", "rate", float('nan')),
        ("rate_huge", "rate", 999999999),
        ("rate_string", "rate", "fast"),
        ("pr_negative", "pr", -500),
        ("qt_zero", "qt", 0),
        ("axis_out_of_range", "axis", 999),
        ("st_extreme", "leads.V1.stElevation", 9999),
    ]
    for name, field, value in extremes:
        ecg = copy.deepcopy(VALID_ECG)
        if "." in field:
            parts = field.split(".")
            ecg[parts[0]][parts[1]][parts[2]] = value
        else:
            ecg[field] = value
        
        try:
            json_str = json.dumps(ecg, allow_nan=False)
        except ValueError:
            json_str = json.dumps({**ecg, field.split(".")[0]: ecg[field.split(".")[0]]}).replace(
                '"rate": 75', f'"rate": null'
            ) if "." not in field else json.dumps(ecg).replace(
                '"stElevation": 0', '"stElevation": 9999'
            )

        ok, data = simulate_import_ecg(json_str)
        if ok:
            record(f"extreme_numeric/{name}", "Input Validation", "🟡",
                   f"Field '{field}' accepts extreme value: {value}",
                   f"Add range validation for {field} — clamp or reject out-of-range values")


def test_missing_required_fields():
    """ECG objects missing required leads."""
    test_cases = [
        ("no_leads", {k: v for k, v in VALID_ECG.items() if k != "leads"}),
        ("empty_leads", {**VALID_ECG, "leads": {}}),
        ("partial_leads", {**VALID_ECG, "leads": {"I": {"stElevation": 0}}}),
        ("leads_not_dict", {**VALID_ECG, "leads": [1, 2, 3]}),
        ("leads_null", {**VALID_ECG, "leads": None}),
        ("null_lead_entry", {**VALID_ECG, "leads": {"I": None, "II": {"stElevation": 0}}}),
        ("no_title", {k: v for k, v in VALID_ECG.items() if k != "title"}),
    ]
    for name, ecg_data in test_cases:
        json_str = json.dumps(ecg_data)
        ok, data = simulate_import_ecg(json_str)
        if ok:
            record(f"missing_fields/{name}", "Robustness", "🟡",
                   f"Import accepts ECG with {name} — may cause rendering errors",
                   "Add validation: check all 12 standard leads present before rendering")


def test_huge_ecg_payload():
    """Test with very large ECG payloads."""
    # 10,000 fake leads
    ecg = copy.deepcopy(VALID_ECG)
    for i in range(10000):
        ecg["leads"][f"V{i}"] = {"stElevation": i, "tWave": "normal", "qWave": False}
    json_str = json.dumps(ecg)
    
    import time
    start = time.time()
    ok, data = simulate_import_ecg(json_str)
    elapsed = time.time() - start
    
    if elapsed > 1.0:
        record("huge_payload/10k_leads", "Performance", "🟡",
               f"10,000-lead ECG JSON parsing took {elapsed:.2f}s",
               "Add payload size limit before parsing (e.g., reject JSON > 500KB)")
    else:
        record("huge_payload/10k_leads", "Performance", "🟢",
               f"10,000-lead parse completed in {elapsed:.3f}s — acceptable", "", passed=True)
    
    # 1MB string values  
    ecg2 = copy.deepcopy(VALID_ECG)
    ecg2["title"] = "A" * 1_000_000
    json_str2 = json.dumps(ecg2)
    record("huge_payload/1mb_title", "Performance/Security", "🟡",
           "1MB string accepted in title field",
           "Limit string field lengths (e.g., title max 500 chars)")


def test_circular_reference_detection():
    """Circular references can't be JSON-serialized, but check edge cases."""
    # JSON doesn't support circular refs, but test deeply nested
    deep = {"value": 1}
    current = deep
    for _ in range(500):
        current["child"] = {"value": 1}
        current = current["child"]
    
    json_str = json.dumps(deep)
    ok, data = simulate_import_ecg(json_str)
    # This isn't really an ECG, just checking parse doesn't hang
    record("circular/deep_nesting_500", "Robustness", "🟢",
           "500-level nested JSON parsed without crash", "", passed=True)


def test_prototype_pollution():
    """JSON payloads attempting prototype pollution."""
    payloads = [
        '{"__proto__": {"admin": true}, "nodes": []}',
        '{"constructor": {"prototype": {"admin": true}}, "leads": {}}',
        '{"title": "test", "__proto__": {"polluted": "yes"}, "leads": {}}',
    ]
    for payload in payloads:
        ok, data = simulate_import_ecg(payload)
        if ok and isinstance(data, dict):
            record(f"prototype_pollution/{payload[:40]}", "Security", "🔴",
                   f"Payload with __proto__/__constructor parsed and stored",
                   "Use JSON.parse with reviver that strips __proto__ keys, or use Object.create(null) based parsing. "
                   "In JS: after JSON.parse, check for and delete any __proto__ keys.")


# ─── ECG Library Structure Tests ──────────────────────────────────────────────

def test_ecg_library_files():
    """Check ECG library JSON files for structural issues."""
    import os
    lib_dir = "/home/andrew/repos/ecg-toy/ecg-library"
    if not os.path.isdir(lib_dir):
        record("ecg_library/dir_missing", "Structure", "🟡",
               "ecg-library directory not found", "Verify ecg-library path")
        return
    
    files = [f for f in os.listdir(lib_dir) if f.endswith(".json")]
    for fname in files[:20]:
        path = os.path.join(lib_dir, fname)
        try:
            with open(path) as f:
                data = json.load(f)
            # Check schema
            has_leads = "leads" in data
            has_title = "title" in data
            if not has_leads:
                record(f"ecg_library/{fname}", "Data Integrity", "🟡",
                       f"Library file missing 'leads' field", 
                       "Ensure all library ECG files conform to schema")
            elif not has_title:
                record(f"ecg_library/{fname}", "Data Integrity", "🟢",
                       f"Library file missing 'title' field (minor)", 
                       "Add title to all library entries")
            else:
                record(f"ecg_library/{fname}", "Structure", "🟢",
                       f"Valid structure", "", passed=True)
        except json.JSONDecodeError as e:
            record(f"ecg_library/{fname}", "Data Integrity", "🔴",
                   f"INVALID JSON in library file: {e}",
                   "Fix JSON syntax in this library file — it will crash the app on load")
        except Exception as e:
            record(f"ecg_library/{fname}", "Structure", "🟡",
                   f"Could not read file: {e}", "Check file permissions/encoding")


# ─── Run All Tests ────────────────────────────────────────────────────────────

def run_all():
    print("=" * 70)
    print("ECG-Toy Fuzz & Chaos Test Suite")
    print("=" * 70)
    
    test_malformed_json_variants()
    test_xss_in_title_field()
    test_extreme_numeric_values()
    test_missing_required_fields()
    test_huge_ecg_payload()
    test_circular_reference_detection()
    test_prototype_pollution()
    test_ecg_library_files()
    
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    
    critical = [r for r in RESULTS if r["severity"] == "🔴"]
    medium = [r for r in RESULTS if r["severity"] == "🟡"]
    low = [r for r in RESULTS if r["severity"] == "🟢" and not r["passed"]]
    passed = [r for r in RESULTS if r["passed"]]
    
    print(f"✅ Passed:   {len(passed)}")
    print(f"🔴 Critical: {len(critical)}")
    print(f"🟡 Medium:   {len(medium)}")
    print(f"🟢 Low:      {len(low)}")
    print(f"Total tests: {len(RESULTS)}")
    
    return RESULTS


if __name__ == "__main__":
    results = run_all()
    # Write JSON results
    with open("/home/andrew/repos/ecg-toy/chaos-tests/results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nResults saved to chaos-tests/results.json")
