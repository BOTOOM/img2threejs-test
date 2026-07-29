#!/usr/bin/env bash
# Run one build pass end to end, up to (but not including) the review.
#
#   tools/run_pass.sh <pass-id> [capture-set] [tier1-render]
#
# The review itself is deliberately NOT automated: the acceptance score has to
# come from vision inspecting the comparison sheet, not from a script.
set -euo pipefail

PASS="${1:?usage: run_pass.sh <pass-id> [capture-set] [tier1-render-suffix]}"
SET="${2:-full}"
# From material-pass onward Tier 1 gates per-part colour delta-E, so it must read
# the BEAUTY render: comparing grey clay against colorMaterialRecipe values would
# fail for a reason that has nothing to do with the materials.
case "$PASS" in
  blockout|structural-pass|form-refinement) DEFAULT_TIER1="reference-clay" ;;
  *) DEFAULT_TIER1="reference" ;;
esac
TIER1_SUFFIX="${3:-$DEFAULT_TIER1}"

OUT="/home/botom/devintest/arena/img2threejs/opus5"
SKILL="/home/botom/devintest/arena/img2threejs/.claude/skills/img2threejs"
cd "$SKILL"

echo "── spec validation (strict) ─────────────────────────────────"
python3 forge/stage2_spec/validate_sculpt_spec.py "$OUT/object-sculpt-spec.json" --strict-quality

# orchestrate_passes.py check is deliberately run at the END, not here: it
# requires a passing Tier-1 record for THIS pass's render, which cannot exist
# before the render is taken. Generation has its own independent pass gate.
echo "── generate factory ────────────────────────────────────────"
python3 forge/stage3_build/generate_threejs_factory.py "$OUT/object-sculpt-spec.json" \
  --out "$OUT/src/generated/catsFactory.$PASS.ts" --pass-id "$PASS" --force > /dev/null
wc -l < "$OUT/src/generated/catsFactory.$PASS.ts" | xargs echo "  emitted TS lines:"

cd "$OUT"
echo "── typecheck ───────────────────────────────────────────────"
npx tsc

echo "── capture ─────────────────────────────────────────────────"
node tools/capture.mjs --pass "$PASS" --set "$SET" 2>&1 \
  | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('  captured:', len(d['captured'])); print('  problems:', d['problems'][:3] if d['problems'] else 'none'); print('  runtime tick:', d['runtime']['hasTick'], '| pivots:', len(d['runtime']['animationPivots']))"

RENDER="$OUT/renders/$PASS-$TIER1_SUFFIX.png"
echo "── silhouette diff ─────────────────────────────────────────"
python3 tools/silhouette_diff.py --reference reference/cats-matte.png --render "$RENDER" \
  --out "review/$PASS-silhouette-diff.png" | head -4

cd "$SKILL"
echo "── tier 1 (recorded) ───────────────────────────────────────"
python3 forge/stage4_review/diagnose_render.py --reference "$OUT/reference/cats-matte.png" \
  --render "$RENDER" --spec "$OUT/object-sculpt-spec.json" --pass-id "$PASS" --in-place 2>&1 \
  | python3 -c "
import json,sys
t=sys.stdin.read(); t=t[t.index('{'):]
d=json.loads(t)
c=d['checks']
print('  passed:', d['passed'])
print('  IoU', c['silhouetteIoU'], '| aspect', c['aspectRatioDelta'], '| scale', c['scaleDelta'])
cd=c.get('colorDelta')
if cd: print('  colorDeltaE max', cd['maxDeltaE'], '| gated', cd['gated'], '| checked', cd['checked'])
if d['failures']: print('  FAILURES:', d['failures'])
"

echo "── divine eye ──────────────────────────────────────────────"
python3 forge/stage4_review/divine_eye.py --reference "$OUT/reference/cats-matte.png" \
  --render "$RENDER" --json 2>&1 | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  verdict', d['verdict'], '| action', d['action'], '| fidelity', d['fidelity'])
print('  hardGateFailures', d['hardGateFailures'] or 'none')
" || true

echo "── multi-angle ─────────────────────────────────────────────"
ORBITS=""
for view in orbit-left-40 orbit-right-40 thickness-axis orbit-back; do
  [ -f "$OUT/renders/$PASS-$view.png" ] && ORBITS="$ORBITS --orbit $OUT/renders/$PASS-$view.png"
done
# shellcheck disable=SC2086
python3 forge/stage4_review/diagnose_render_multi_angle.py --reference "$RENDER" $ORBITS --json 2>&1 \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  degenerate:', d['degenerate'])
for a in d['angles']:
    print('   ', a['path'].split('/')[-1].ljust(40), 'ratio', round(a['ratio'],3), 'degenerate', a['degenerate'])
"

echo "── comparison sheet ────────────────────────────────────────"
SHEET_RENDER="$OUT/renders/$PASS-reference.png"
[ -f "$SHEET_RENDER" ] || SHEET_RENDER="$RENDER"
python3 forge/stage4_review/make_comparison_sheet.py --reference "$OUT/reference/cats-matte.png" \
  --render "$SHEET_RENDER" --out "$OUT/review/$PASS-comparison.png" \
  --panel-width 700 --panel-height 640 > /dev/null
echo "  review/$PASS-comparison.png  (render: $(basename "$SHEET_RENDER"))"

echo "── pass gate (now that tier 1 is recorded) ─────────────────"
python3 forge/stage3_build/orchestrate_passes.py check "$OUT/object-sculpt-spec.json" \
  --pass-id "$PASS" 2>&1 | tail -2
echo "done: inspect the sheet, then append_review.py"
