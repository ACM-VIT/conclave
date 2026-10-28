"""Independent expected geometry, archived-semantics replay and fail-closed generator regressions.

No renderer oracle and no converter self-comparison: expected coordinates are hand-derived, the
winding sampler only inspects explicit line segments, and binding semantics are replayed from the
sealed archived construction records rather than from the manifest under test.
"""
import ast
import copy
from fractions import Fraction as F
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('icons', Path(__file__).with_name('gen-native-icons.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
MANIFEST = g.ROOT / g.ICON / 'manifest.json'


# ---------------------------------------------------------------- archived semantics replay

def archived_text(name):
    return json.loads((g.ROOT / g.EVIDENCE / name).read_bytes())['item']['text']


def archived_literal(source, pattern):
    match = re.search(pattern, source, re.S)
    assert match, pattern
    return ast.literal_eval(match.group(1))


def replay_archived_semantics(index_concepts):
    """Replays manifest-activity 0-47 construction plus the 0-59 and 0-83 patches.

    Literal data comes verbatim from the archived scripts; the control flow mirrors their code.
    The F00 label and SF cells come from the accepted selected-input index.
    """
    t47 = archived_text('manifest-activity-0-47.json')
    t59 = archived_text('manifest-activity-0-59.json')
    t83 = archived_text('manifest-activity-0-83.json')
    data = archived_literal(t47, r'\ndata=(\[\n.*?\n\])\n')
    explicit = archived_literal(t47, r'\nexplicit=(\{[^\n]*\})\n')
    choices = archived_literal(t47, r'\nchoices=(\{\n.*?\n\})\n')
    extra_sf = archived_literal(t47, r'\nextra_sf=(\{[^\n]*\})\n')
    decisions = archived_literal(t47, r'for i,s in (\[\n.*?\])\],')
    policy = archived_literal(t47, r"'accessibility_policy':(\{.*?\}),\n")
    contexts = archived_literal(t59, r'\ncontexts=(\{\n.*?\n\})\n')
    for key in ['roles', 'state_only_style']:
        policy[key] = re.search(r"d\['accessibility_policy'\]\['" + key + r"'\]='([^'\n]*)'\n", t59).group(1)
    values = archived_literal(t83, r'\n  values=(\{[^\n]*\})\n')
    assert len(data) == len(index_concepts) == 36
    concepts = []
    for c, (cid, pairs, role, value, _) in zip(index_concepts, data):
        assert c['id'] == cid
        labels = re.findall(r'"([^"]+)"', c['canonical_label_cell'])
        line = c['canonical_line_at_recovery']
        symbols = []
        for name in re.findall(r'`([^`]+)`', c['canonical_sf_cell']):
            if name.startswith('Button(') or name == 'AVRoutePickerView':
                continue
            # 0-59 replaced every canonical context with its reviewed contextual meaning.
            symbols.append({'name': name, 'context': contexts.get(cid, {}).get(
                name, 'canonical ' + cid + ' use; exact literal takes precedence over generic fill convention')})
        for name, context, _, _ in extra_sf.get(cid, []):
            symbols.append({'name': name, 'context': context})
        if cid == 'copy_link':
            symbols.append({'name': 'checkmark', 'context': 'copied_confirmation'})
        bindings = []
        for pair in pairs.split(';'):
            name, fill, state = pair.split(':')
            fill = int(fill)
            basis = 'requirement' if (name, fill) in explicit else (
                'derived_requirement' if name in ['lock', 'lock_open', 'cancel_presentation']
                or (name == 'present_to_all' and fill == 0) else 'recommendation')
            decision = None if (name, fill) in explicit else choices.get(name, ('D01', ''))[0]
            references = ['S10:493', 'S10:952'] if cid == 'copy_link' and name == 'check' else [f'F00:{line}']
            label, arole, avalue = (labels[0] if labels else None), role, value
            if cid == 'pin':
                label = {'pin_action': 'Pin', 'unpin_action': 'Unpin', 'pinned_badge': None}[state]
                arole = 'status' if state == 'pinned_badge' else 'button'
                avalue = 'pinned' if state == 'pinned_badge' else None
            if cid == 'share_screen' and state == 'presenting_badge':
                label, arole, avalue = None, 'status', 'presenting'
            if cid == 'search':
                arole, label = 'decorative', None
            if cid in ['speaking', 'weak_connection', 'warning_error_info']:
                label = None
            bindings.append({'state': state, 'artwork': f'{name}.fill{fill}', 'fill_basis': basis,
                             'decision_id': decision, 'references': references,
                             'accessibility': {'label': label, 'value': avalue, 'role': arole,
                                               'icon_exposure': 'decorative_in_labeled_owner'}})
        # Patch 0-59.
        for b in bindings:
            if cid == 'participants':
                b['accessibility']['value'] = 'participant and waiting counts; open selection semantics recommended with D02'
            if cid == 'host':
                b['state'] = 'host_badge'
                b['accessibility']['label'] = None
        if cid == 'host':
            bindings.append({'state': 'host_controls_action', 'artwork': 'shield_person.fill0', 'fill_basis': 'recommendation',
                             'decision_id': 'D01', 'references': ['S30:696'],
                             'accessibility': {'label': 'Host controls', 'value': None, 'role': 'button',
                                               'icon_exposure': 'decorative_in_labeled_owner'}})
        if cid == 'search':
            bindings.append({'state': 'search_action', 'artwork': 'search.fill0', 'fill_basis': 'recommendation',
                             'decision_id': 'D01', 'references': ['F00:896'],
                             'accessibility': {'label': 'Search', 'value': None, 'role': 'button',
                                               'icon_exposure': 'decorative_in_labeled_owner'}})
        if cid == 'lock_meeting':
            for b in bindings:
                b['accessibility']['role'] = 'checkbox'
                b['references'].append('S50:908')
        # Patch 0-83.
        for b in bindings:
            if (cid, b['state']) in values:
                b['accessibility']['value'] = values[(cid, b['state'])]
        if cid == 'share_screen':
            sharing = next(b for b in bindings if b['state'] == 'sharing_stop_action')
            sharing['state'] = 'sharing_toggle'
            action = copy.deepcopy(sharing)
            action['state'] = 'stop_sharing_action'
            action['accessibility'] = {'label': 'Stop sharing', 'value': None, 'role': 'button',
                                       'icon_exposure': 'decorative_in_labeled_owner'}
            bindings.append(action)
        if cid == 'reactions':
            for b in bindings:
                b['references'].append('S30:762')
        system = []
        if cid == 'audio_output':
            system = [{'kind': 'route_picker', 'policy': 'AVRoutePickerView owns glyph and route semantics; no SF string synthesized.'}]
        if cid == 'back':
            system = [{'kind': 'system_navigation_back', 'policy': 'System back owns its symbol, label and RTL behavior; no SF string synthesized.'}]
        if cid == 'close':
            system = [{'kind': 'system_close', 'policy': 'Button(role: .close) only with iOS 26 runtime guard in native iOS file; older path uses explicitly labeled Close/Done or xmark according to host. Guard/minimum-OS validation remains open.'}]
        concepts.append({'id': cid, 'sf_symbols': symbols, 'ios_system': system, 'bindings': bindings})
    return {'concepts': concepts, 'decisions': dict(decisions), 'accessibility': policy}


def vendored_index():
    return json.loads((g.ROOT / g.VENDOR / 'selected-input-index.json').read_bytes())


class ArchivedSemantics(unittest.TestCase):
    def test_manifest_semantics_replay_sealed_archived_records(self):
        manifest = json.loads(MANIFEST.read_bytes())
        replay = replay_archived_semantics(vendored_index()['concepts'])
        self.assertEqual(manifest['decisions'], replay['decisions'])
        self.assertEqual(manifest['accessibility'], replay['accessibility'])
        # Explicit length check instead of zip(strict=True), which needs Python 3.10 (macOS system python3 is 3.9).
        self.assertEqual(len(manifest['concepts']), len(replay['concepts']))
        for actual, expected in zip(manifest['concepts'], replay['concepts']):
            with self.subTest(concept=expected['id']):
                self.assertEqual({k: actual[k] for k in expected}, expected)
        self.assertEqual(sum(len(c['bindings']) for c in replay['concepts']), 58)

    def test_contract_semantics_spot_checks(self):
        # Fixed expectations from the recovered contract's accessibility section, not from the replay.
        manifest = json.loads(MANIFEST.read_bytes())
        b = {f"{c['id']}.{x['state']}": x for c in manifest['concepts'] for x in c['bindings']}
        acc = {k: (v['accessibility']['label'], v['accessibility']['value'], v['accessibility']['role']) for k, v in b.items()}
        self.assertEqual(acc['microphone.on'], ('Microphone', 'On', 'switch'))
        self.assertEqual(acc['microphone.muted'], ('Microphone', 'Muted', 'switch'))
        self.assertEqual(acc['camera.off'], ('Camera', 'Off', 'switch'))
        self.assertEqual(acc['raise_hand.raised'], ('Raise hand', 'Raised', 'switch'))
        self.assertEqual(acc['raise_hand.lowered'], ('Raise hand', 'Not raised (Android); absent (iOS)', 'switch'))
        self.assertEqual(acc['captions.on'], ('Captions', 'On', 'switch'))
        self.assertEqual((acc['reactions.closed'][1], acc['reactions.open'][1]), ('Closed', 'Open'))
        self.assertEqual(acc['share_screen.sharing_toggle'], ('Share screen', 'Sharing', 'switch'))
        self.assertEqual(acc['share_screen.stop_sharing_action'], ('Stop sharing', None, 'button'))
        self.assertEqual(acc['host.host_badge'][2], 'status')
        self.assertEqual(acc['host.host_controls_action'], ('Host controls', None, 'button'))
        self.assertEqual(acc['search.decorative_field_leading'], (None, None, 'decorative'))
        self.assertEqual(acc['search.search_action'], ('Search', None, 'button'))
        self.assertEqual(acc['lock_meeting.locked'][2], 'checkbox')
        self.assertEqual(acc['audio_output.bluetooth'][::2], ('Audio output', 'button'))
        self.assertEqual(b['admit.action']['artwork'], b['copy_link.copied']['artwork'])
        self.assertEqual([a['id'] for a in manifest['artwork'] if a['autoMirror']], list(g.MIRRORED))
        self.assertIsNone(manifest['accessibility']['android_child_contentDescription'])


# ---------------------------------------------------------------- converter semantics

class PathSemantics(unittest.TestCase):
    def test_initial_relative_and_implicit_repetition(self):
        self.assertEqual(g.normalize('m10 -950 20 0 0 20z'), [('M', 10, 10), ('L', 30, 10), ('L', 30, 30), ('Z',)])
        self.assertEqual(g.normalize('M10 -950 30 -950 30 -930'), [('M', 10, 10), ('L', 30, 10), ('L', 30, 30)])

    def test_quadratic_relative_reflection_repeated(self):
        self.assertEqual(g.normalize('M10 -950q10 0 10 10t10 10 10 -10'),
                         [('M', 10, 10), ('Q', 20, 10, 20, 20), ('Q', 20, 30, 30, 30), ('Q', 40, 30, 40, 20)])
        self.assertEqual(g.normalize('M0 -960Q10 -960 20 -950 30 -940 40 -950T60 -950 80 -950'),
                         [('M', 0, 0), ('Q', 10, 0, 20, 10), ('Q', 30, 20, 40, 10), ('Q', 50, 0, 60, 10), ('Q', 70, 20, 80, 10)])

    def test_reflection_reset_and_close_current_point(self):
        self.assertEqual(g.normalize('M10 -950Q20 -950 20 -940L30 -930T40 -920M50 -910T60 -900Z m10 20t10 0'),
                         [('M', 10, 10), ('Q', 20, 10, 20, 20), ('L', 30, 30), ('Q', 30, 30, 40, 40), ('M', 50, 50),
                          ('Q', 50, 50, 60, 60), ('Z',), ('M', 60, 70), ('Q', 60, 70, 70, 70)])
        self.assertEqual(g.normalize('M10 -950Q20 -950 20 -940ZT30 -930'),
                         [('M', 10, 10), ('Q', 20, 10, 20, 20), ('Z',), ('Q', 10, 10, 30, 30)])
        # H and V reset reflection exactly like L.
        self.assertEqual(g.normalize('M0 -960Q10 -960 10 -950H20T30 -950'),
                         [('M', 0, 0), ('Q', 10, 0, 10, 10), ('L', 20, 10), ('Q', 20, 10, 30, 10)])

    def test_hv_both_cases_and_zero_length(self):
        self.assertEqual(g.normalize('M10 -950h20v20H40V-910l0 0z'),
                         [('M', 10, 10), ('L', 30, 10), ('L', 30, 30), ('L', 40, 30), ('L', 40, 50), ('L', 40, 50), ('Z',)])

    def test_exact_decimal_exponent_and_adjacent_sign_dot(self):
        self.assertEqual(g.normalize('m.1,-9.599e2.2-.1L+3e-1 -960'),
                         [('M', F('0.1'), F('0.1')), ('L', F('0.3'), 0), ('L', F('0.3'), 0)])
        self.assertEqual(g.normalize('M0 -960' + ' l.1 .1' * 100)[-1], ('L', 10, 10))

    def test_malformed_and_resource_limits(self):
        bad = ['', 'L0 0', 'M0', 'M0 0 1', 'M,0 0', 'M0,,0', 'M0 0,', 'M0 0,L1 1', 'M0 0Z1 1', 'M0 0C1 1 2 2 3 3',
               'MNaN 0', 'M0 inf', 'M0 0Q1 2 3', 'M0 0T1', 'M0e 0', 'M1e513 0', 'M' + ('1' * 129) + ' 0',
               'M0 0L', 'M0 0LZ', 'M0 0L Z', 'M0 0 L M1 1', 'M0 0H', 'm', 'M0 0\x0cL1 1', 'M0 0 L,1 1']
        for source in bad:
            with self.subTest(source=source[:35]), self.assertRaises(g.IconError):
                g.normalize(source)
        with self.assertRaises(g.IconError):
            g.normalize('M0 0' + 'L0 0' * 10000)

    def test_float32_exact_tie_and_roundtrip_error(self):
        self.assertEqual(g.float_literal(F(1) + F(1, 2 ** 24), 'tie')[0], '1.0f')
        self.assertEqual(g.float_literal(F(1) + F(1, 2 ** 24) + F(1, 10 ** 80), 'above')[0], '1.00000012f')
        self.assertEqual(g.float_literal(F('-0'), 'zero')[0], '0.0f')
        # Nearest binary32 to 1/10 is 13421773/2**27, so the exact error is 2/(10*2**27).
        self.assertEqual(g.float_literal(F('0.1'), 'tenth'), ('0.100000001f', F(1, 671088640)))
        with self.assertRaises(g.IconError):
            g.float_literal(F('1e100'), 'overflow')


class XMLProfile(unittest.TestCase):
    def svg(self, path='M0 -960Z'):
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 -960 960 960"><path d="{path}"/></svg>'.encode()

    def test_originals_and_exact_structure(self):
        self.assertEqual(g.svg_path(self.svg()), 'M0 -960Z')
        m, _ = g.validate(g.ROOT)
        for a in m['artwork']:
            self.assertTrue(g.artwork_ops(g.ROOT, a))
            if '_vendor_root' not in a:
                self.assertTrue(g.normalize(g.svg_path((g.ROOT / g.VENDOR / a['local_path']).read_bytes(), a['id'])))

    def test_reject_features_and_entity_expansion(self):
        raw = self.svg()
        bad = [raw.replace(b'<svg', b'<?xml version="1.0"?><svg'), raw.replace(b'<path', b'<!-- hi --><path'),
               raw.replace(b'<path', b'<?foo hi?><path'), raw.replace(b'<path', b'<![CDATA[x]]><path'),
               raw.replace(b'<path', b'<g><path').replace(b'</svg>', b'</g></svg>'), raw.replace(b'width="24"', b'width="25"'),
               raw.replace(b'<path', b'<path fill="black"'), raw.replace(b'<path', b'hello<path'),
               raw.replace(b'<path', b'<path d="M0 0"/><path'), raw.replace(b'M0 -960Z', b'M&#48; -960Z'),
               b'<!DOCTYPE svg [<!ENTITY x "value">]>' + raw, raw.replace(b'<svg', b'<svg xmlns:x="urn:x"'),
               raw.replace(b'<path', b'<path transform="translate(0 0)"'), raw.replace(b'"/>', b'"><title>x</title></path>'),
               raw.replace(b'viewBox="0 -960 960 960"', b'viewBox="0 0 960 960"')]
        for data in bad:
            with self.subTest(data=data[:90]), self.assertRaises(g.IconError):
                g.svg_path(data)
        with self.assertRaises(g.IconError):
            g.svg_path(b' ' * 131073)

    def test_only_xml_whitespace_may_separate_elements(self):
        # XML S is space, tab, CR and LF. Other Unicode spaces are character data, although str.isspace() is true.
        raw = self.svg()
        for space in [' ', '\t', '\n', '\r\n', ' \t\r\n ']:
            for data in [raw.replace(b'<path', space.encode() + b'<path'), raw.replace(b'</svg>', space.encode() + b'</svg>')]:
                with self.subTest(space=repr(space)):
                    self.assertEqual(g.svg_path(data), 'M0 -960Z')
        for char in ['\u0085', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　']:
            self.assertTrue(char.isspace())
            for data in [raw.replace(b'<path', (' ' + char + '\n').encode() + b'<path'),
                         raw.replace(b'</svg>', char.encode() + b'</svg>')]:
                with self.subTest(char=f'U+{ord(char):04X}'):
                    with self.assertRaises(g.IconError) as caught:
                        g.svg_path(data)
                    self.assertEqual(caught.exception.details['code'], 'E_SVG_PROFILE')
                    self.assertEqual(caught.exception.details['reason'], 'text content forbidden')


# These fixed specimens are hand-derived from the recovered mathematical contract.
# The winding sampler inspects the resulting explicit lines; it is not another SVG normalizer.
def line_winding(ops, point):
    x, y = point
    winding, current, start = 0, None, None
    for op in ops:
        if op[0] == 'M':
            current = start = op[1:]
            continue
        if op[0] == 'Q':
            raise AssertionError('polygon sampler receives lines only')
        end = start if op[0] == 'Z' else op[1:]
        a, b = current, end
        cross = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])
        if a[1] <= y < b[1] and cross > 0:
            winding += 1
        if b[1] <= y < a[1] and cross < 0:
            winding -= 1
        current = end
    return winding


class IndependentGeometry(unittest.TestCase):
    def fixtures(self):
        return json.loads((g.ROOT / g.ICON / 'semantic-fixtures.json').read_text())['fixtures']

    def test_opposite_and_same_nonzero_winding(self):
        a, b, *_ = self.fixtures()
        for fixture, center in [(a, False), (b, True)]:
            ops = g.normalize(fixture['path'])
            self.assertEqual(bool(line_winding(ops, (480, 480))), center)
            self.assertTrue(line_winding(ops, (220, 480)))
            self.assertFalse(line_winding(ops, (20, 20)))
            points = [op[1:] for op in ops if op[0] != 'Z']
            self.assertEqual((min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points),
                              max(p[1] for p in points)), (160, 160, 800, 800))

    def test_relative_after_close_separate_components(self):
        ops = g.normalize(self.fixtures()[2]['path'])
        self.assertEqual(ops, [('M', 160, 160), ('L', 320, 160), ('L', 320, 320), ('L', 160, 320), ('Z',),
                               ('M', 480, 480), ('L', 640, 480), ('L', 640, 640), ('L', 480, 640), ('Z',)])
        for point, inside in [((240, 240), True), ((560, 560), True), ((400, 400), False), ((560, 720), False)]:
            self.assertEqual(bool(line_winding(ops, point)), inside)

    def test_smooth_controls_and_analytic_extremum(self):
        ops = g.normalize(self.fixtures()[3]['path'])
        self.assertEqual(ops, [('M', 160, 480), ('Q', 320, 160, 480, 480), ('Q', 640, 800, 800, 480), ('L', 800, 800),
                               ('L', 160, 800), ('Z',)])
        # Quadratic derivative gives t=(p0-p1)/(p0-2*p1+p2), independent of the parser.
        p0, p1, p2 = F(480), F(160), F(480)
        t = (p0 - p1) / (p0 - 2 * p1 + p2)
        self.assertEqual(t, F(1, 2))
        self.assertEqual((1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t * t * p2, 320)
        self.assertEqual((160 * F(72, 960), 320 * F(72, 960), 800 * F(72, 960)), (12, 24, 60))


# ---------------------------------------------------------------- validation, outputs and drift

def mutated(mutation):
    original = MANIFEST.read_bytes()
    read = Path.read_bytes
    m = json.loads(original)
    mutation(m)

    def fake(path):
        return json.dumps(m, ensure_ascii=False).encode() if path == MANIFEST else read(path)
    return patch.object(Path, 'read_bytes', fake)


def binding(m, key):
    concept, state = key.split('.')
    return next(b for c in m['concepts'] if c['id'] == concept for b in c['bindings'] if b['state'] == state)


class ValidationAndDrift(unittest.TestCase):
    def test_additions_preserve_base_selection_and_append_only(self):
        base = json.loads(MANIFEST.read_bytes())
        merged, _ = g.validate(g.ROOT)
        self.assertEqual(merged['concepts'][:36], base['concepts'])
        self.assertEqual(merged['artwork'][:54], base['artwork'])
        self.assertEqual(merged['sf_literals'][:50], base['sf_literals'])
        self.assertEqual(g.digest(g.canonical(base['vendor_files'])), g.VENDOR_SEAL_SHA)
        ext = json.loads((g.ROOT / g.ADDITIONS / 'manifest.json').read_bytes())
        self.assertEqual(ext['history'], {'fresh_pinned_acquisitions': 61, 'historical_exact_matches': 0})
        self.assertEqual(len(ext['concepts']), 70)
        self.assertEqual(len(ext['sf_literals']), 69)
        self.assertNotIn('xmark.bubble', merged['sf_literals'])
        dismiss = next(c for c in ext['concepts'] if c['id'] == 'dismiss_question')
        self.assertEqual(dismiss['sf_symbols'][0]['name'], 'xmark.circle')
        self.assertEqual(dismiss['bindings'][0]['artwork'], 'cancel.fill0')

    def test_addition_receipts_axes_and_semantics_fail_closed_after_resealing(self):
        # Recompute the outer hash to exercise the inner constraints, not just the seal.
        path = g.ROOT / g.ADDITIONS / 'manifest.json'
        original = json.loads(path.read_bytes())
        read = Path.read_bytes
        mutations = {
            'wrong pin': lambda m: m.update(source_revision='0' * 40),
            'wrong license': lambda m: m.update(license_sha256='0' * 64),
            'wrong axes evidence': lambda m: m.update(axis_evidence='unverified.json'),
            'wrong implicit geometry identity': lambda m: next(a for a in m['artwork'] if a['id'] == 'auto_awesome.fill0').update(sha256='0' * 64),
            'duplicate base artwork': lambda m: m['artwork'][0].update(id='check.fill0'),
            'extra receipt': lambda m: m['files'].update({'http/extra.json': '0' * 64}),
            'changed mirroring': lambda m: m['artwork'][0].update(autoMirror=True),
            'missing binding': lambda m: m['concepts'][0].update(bindings=[]),
            'duplicate base concept': lambda m: m['concepts'][0].update(id='microphone'),
            'raw glyph label': lambda m: m['concepts'][0]['bindings'][0]['accessibility'].update(label='video_call.fill0'),
            'unlocalized icon owner': lambda m: m['concepts'][0]['bindings'][0]['accessibility'].update(icon_exposure='spoken'),
            'unavailable literal': lambda m: m['sf_literals'].append('xmark.bubble'),
            'cyclic alias': lambda m: m['aliases'].update(retry='rejoin'),
            'false historical claim': lambda m: m['history'].update(historical_exact_matches=1),
            'request absent': lambda m: m['concepts'][0]['bindings'][0].update(references=[]),
            'undocumented fill': lambda m: m['concepts'][0]['bindings'][0].update(decision_id='P99'),
        }
        for name, mutate in mutations.items():
            changed = json.loads(json.dumps(original))
            mutate(changed)
            payload = json.dumps(changed).encode()
            base = json.loads(MANIFEST.read_bytes())
            base['additions']['sha256'] = g.digest(payload)
            def fake(p):
                if p == path:
                    return payload
                if p == MANIFEST:
                    return json.dumps(base).encode()
                return read(p)
            with self.subTest(name=name), patch.object(Path, 'read_bytes', fake), self.assertRaises(g.IconError):
                g.generate(g.ROOT)

    def test_implicit_viewport_is_scoped_and_scaled_without_geometry_substitution(self):
        m, _ = g.validate(g.ROOT)
        a = next(a for a in m['artwork'] if a['id'] == 'auto_awesome.fill0')
        raw = (g.ROOT / g.ADDITIONS / a['local_path']).read_bytes()
        with self.assertRaises(g.IconError):
            g.svg_path(raw, a['id'])  # the original font960 profile is still strict
        self.assertEqual(g.digest(raw), g.ADDITIVE_24PX[a['id']])
        ops = g.artwork_ops(g.ROOT, a)
        # Independent first contour coordinates from the original 24px source.
        self.assertEqual(ops[:2], [('M', F(760), F(332)), ('Q', F(755), F(332), F(18738, 25), F(329))])
        self.assertEqual(ops[-2:], [('M', F(360), F(480)), ('Z',)])
        self.assertTrue(all(0 <= v <= 960 for op in ops for v in op[1:]))

    def test_extension_origin_receipt_rejects_redirects_and_wrong_commit(self):
        read = Path.read_bytes
        ext_path = g.ROOT / g.ADDITIONS / 'manifest.json'
        receipt_name = 'http/reply.fill0.json'
        receipt_path = g.ROOT / g.ADDITIONS / receipt_name
        for field, value in [('final_url', 'https://example.invalid/reply.svg'),
                             ('source_revision', '0' * 40), ('http_status', 302),
                             ('bytes', 0), ('historical_status', 'historical_exact_match')]:
            receipt = json.loads(read(receipt_path))
            receipt[field] = value
            receipt_bytes = json.dumps(receipt).encode()
            extension = json.loads(read(ext_path))
            extension['files'][receipt_name] = g.digest(receipt_bytes)
            ext_bytes = json.dumps(extension).encode()
            base = json.loads(read(MANIFEST))
            base['additions']['sha256'] = g.digest(ext_bytes)
            def fake(p):
                if p == receipt_path:
                    return receipt_bytes
                if p == ext_path:
                    return ext_bytes
                if p == MANIFEST:
                    return json.dumps(base).encode()
                return read(p)
            with self.subTest(field=field), patch.object(Path, 'read_bytes', fake), self.assertRaises(g.IconError):
                g.generate(g.ROOT)

    def test_duplicate_keys_nonfinite_and_closed_schema(self):
        for data in ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":-Infinity}']:
            with self.subTest(data=data), self.assertRaises(g.IconError):
                g.strict_json(data)
        mutations = {
            'extra field': lambda m: m.update(extra=True),
            'old schema': lambda m: m.update(schema_version=1),
            'boolean fill': lambda m: m['artwork'][0].update(fill=False),
            'unexpected mirroring': lambda m: m['artwork'][0].update(autoMirror=True),
            'unknown role': lambda m: binding(m, 'microphone.on')['accessibility'].update(role='image'),
            'unknown artwork': lambda m: binding(m, 'microphone.on').update(artwork='unknown.fill0'),
            'missing vendor input': lambda m: m['vendor_files'].pop(next(iter(m['vendor_files']))),
            'unexplained SF literal': lambda m: m['sf_literals'].append('fake'),
            'status with owner label': lambda m: binding(m, 'host.host_badge')['accessibility'].update(label='Host'),
            'control without label': lambda m: binding(m, 'leave.action')['accessibility'].update(label=None),
            'undeclared fill': lambda m: binding(m, 'participants.open').update(decision_id='D99'),
            'requirement with decision': lambda m: binding(m, 'microphone.on').update(decision_id='D01'),
            'bad reference': lambda m: binding(m, 'send.ready_or_disabled').update(references=['F00:0']),
            'raw glyph label': lambda m: binding(m, 'delete.action')['accessibility'].update(label='delete.fill0'),
            'dash in label': lambda m: binding(m, 'delete.action')['accessibility'].update(label='Delete ' + chr(0x2014) + ' now'),
            'unknown accessibility key': lambda m: binding(m, 'delete.action')['accessibility'].update(hint='x'),
            'unknown system kind': lambda m: next(c for c in m['concepts'] if c['id'] == 'back')['ios_system'][0].update(kind='custom'),
            'missing SF context': lambda m: m['concepts'][0]['sf_symbols'].pop(),
            'evidence set': lambda m: m['semantics_evidence'].update(extra='0' * 64),
            'decision inventory': lambda m: m['decisions'].pop('D10'),
            'artwork owns description': lambda m: m['accessibility'].update(android_child_contentDescription='Mic'),
            'state rename': lambda m: binding(m, 'share_screen.stop_sharing_action').update(state='stop'),
            'false history': lambda m: m['history'].update(historical_exact_matches=6),
        }
        for name, mutation in mutations.items():
            with self.subTest(mutation=name), mutated(mutation), self.assertRaises(g.IconError):
                g.validate(g.ROOT)

    def test_changed_inputs_and_evidence_fail_before_writes(self):
        read = Path.read_bytes
        targets = [g.ROOT / g.VENDOR / 'upstream/LICENSE', g.ROOT / g.EVIDENCE / 'manifest-activity-0-59.json',
                   g.ROOT / g.VENDOR / 'assets/symbols/web/send/materialsymbolsrounded/send_fill1_24px.svg']
        for target in targets:
            def fake(path, target=target):
                data = read(path)
                return data + b' ' if path == target else data
            with self.subTest(target=target.name), patch.object(Path, 'read_bytes', fake), self.assertRaises(g.IconError):
                g.generate(g.ROOT)

    def test_path_escape_and_symlinks(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'link').symlink_to('/etc')
            for path in ['../bad', '/etc/passwd', 'link/passwd', '']:
                with self.subTest(path=path), self.assertRaises(g.IconError):
                    g.safe(root, path)

    def test_literal_escaping_and_identifier_injection(self):
        self.assertEqual(g.kotlin_string('a"$\\b'), '"a\\"\\$\\\\b"')
        self.assertEqual(g.swift_string('a"\\(b)'), '"a\\"\\\\(b)"')
        self.assertEqual((g.kotlin_string(None), g.swift_string(None)), ('null', 'nil'))
        for unsafe in ['a\nb', 'tab\there']:
            with self.assertRaises(g.IconError):
                g.kotlin_string(unsafe)
            with self.assertRaises(g.IconError):
                g.swift_string(unsafe)
        fixtures = g.ROOT / g.ICON / 'semantic-fixtures.json'
        read = Path.read_bytes
        injected = json.loads(fixtures.read_bytes())
        injected['fixtures'][0]['property'] = 'Bad = TODO()\n    val X'

        def fake(path):
            return json.dumps(injected).encode() if path == fixtures else read(path)
        with patch.object(Path, 'read_bytes', fake), self.assertRaises(g.IconError):
            g.generate(g.ROOT)

    def test_drift_is_nonwriting_missing_stale_extra(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / g.ICON).mkdir(parents=True)
            outputs = {g.ANDROID / 'ConclaveIcons.kt': b'expected\n'}
            with self.assertRaises(g.IconError):
                g.publish(root, outputs, True)
            self.assertFalse((root / g.ANDROID).exists())
            g.publish(root, outputs)
            g.publish(root, outputs, True)
            path = root / g.ANDROID / 'ConclaveIcons.kt'
            path.write_bytes(b'stale')
            before = path.stat().st_mtime_ns
            with self.assertRaises(g.IconError):
                g.publish(root, outputs, True)
            self.assertEqual(path.read_bytes(), b'stale')
            self.assertEqual(path.stat().st_mtime_ns, before)
            (path.parent / 'Extra.kt').write_bytes(b'extra')
            with self.assertRaises(g.IconError):
                g.publish(root, outputs)
            self.assertEqual(path.read_bytes(), b'stale')
            self.assertEqual(sorted(p.name for p in (root / g.ICON).iterdir()), [])

    def test_checked_in_outputs_match_without_writing(self):
        outputs = g.generate(g.ROOT)
        before = {rel: (g.ROOT / rel).stat().st_mtime_ns for rel in outputs}
        self.assertEqual(g.publish(g.ROOT, outputs, check=True), [])
        self.assertEqual(before, {rel: (g.ROOT / rel).stat().st_mtime_ns for rel in outputs})

    def test_determinism_inventory_license_and_lazy_shape(self):
        a = g.generate(g.ROOT)
        b = g.generate(g.ROOT)
        self.assertEqual(a, b)
        report = json.loads(a[g.REPORT])
        self.assertEqual(report['base_counts'], g.COUNTS)
        self.assertEqual(report['counts'], {'concepts': 106, 'material_names': 108, 'artwork': 115, 'bindings': 134, 'sf_literals': 116})
        self.assertEqual(len(report['assets']), 115)
        self.assertTrue(all(F(x['maximum_float32_error']) == 0 for x in report['assets'][:54]))
        self.assertTrue(all(F(x['maximum_float32_error']) <= F(1, 51200) for x in report['assets']))
        vectors = a[g.ANDROID / 'ConclaveIcons.kt'].decode()
        self.assertEqual(vectors.count('lazy(LazyThreadSafetyMode.SYNCHRONIZED)'), 115)
        self.assertEqual(vectors.count('internal val '), 115)
        self.assertEqual(vectors.count('autoMirror = true'), 4)
        self.assertEqual(len(re.findall(r'// [a-z_]+\.fill[01]; input SHA256 [0-9a-f]{64}\.', vectors)), 115)
        self.assertIn('Material Symbols by Google', vectors)
        self.assertIn('PathFillType.NonZero', vectors)
        self.assertNotIn('EvenOdd', vectors)
        self.assertNotRegex(vectors, r'\bmapOf\b|\barrayOf\b|\binit \{|PathParser|addPathNodes|\bparse\w*\(')
        catalog = a[g.ANDROID / 'NativeIconCatalog.kt'].decode()
        self.assertEqual(catalog.count('NativeIconBinding('), 134)
        self.assertEqual(catalog.count('NativeIconArtwork('), 115)
        symbols = a[g.IOS / 'ConclaveSymbols.swift'].decode()
        self.assertEqual(symbols.count('static let '), 116)
        self.assertIn('#if os(iOS) && !SKIP', symbols)
        self.assertNotRegex(symbols, r'\bcase\b|func |\.fill"\s*\+')
        rows = a[g.IOS / 'NativeSymbolCatalog.swift'].decode()
        self.assertEqual(rows.count('symbol: ConclaveSymbols.'), sum(len(c['sf_symbols']) for c in g.validate(g.ROOT)[0]['concepts']))
        self.assertEqual(rows.count('symbol: nil'), 3)
        license_bytes = (g.ROOT / g.VENDOR / 'upstream/LICENSE').read_bytes()
        self.assertEqual(g.digest(license_bytes), g.LICENSE_SHA)
        self.assertEqual(a[g.IOS_LICENSE], license_bytes)
        self.assertEqual(a[g.ANDROID_LICENSE], license_bytes)
        self.assertIn(b'APPENDIX: How to apply the Apache License', license_bytes)
        generated = b''.join(v for k, v in a.items() if k not in (g.IOS_LICENSE, g.ANDROID_LICENSE)).decode()
        for forbidden in ['/Users/', '/tmp/', chr(0x2013), chr(0x2014), '\r']:
            self.assertNotIn(forbidden, generated)


def drawable(outputs, name):
    return outputs[g.DRAWABLES / (name + '.xml')].decode()


def xml_attr(source, name):
    values = re.findall(r'\b' + re.escape(name) + r'="([^"]*)"', source)
    assert len(values) == 1, (name, values)
    return values[0]


def kotlin_vector_numbers(prop):
    """Coordinates of one lazy ImageVector in the checked-in ConclaveIcons.kt, in emission order."""
    source = (g.ROOT / g.ANDROID / 'ConclaveIcons.kt').read_text()
    body = re.search(r'private val ' + prop + r'Cache = lazy.*?\.build\(\)', source, re.S).group(0)
    return [F(n.rstrip('f')) for n in re.findall(r'-?[0-9][0-9.e+-]*f', body.split('path(fill', 1)[1])]


BRAND_FIXTURE = (b'<svg width="400" height="400" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">\n'
                 b'<path fill-rule="evenodd" clip-rule="evenodd" d="M200 0L400 200L200 400L0 200Z'
                 b'M150 180H250V220H150Z" fill="#F95F4A"/>\n</svg>\n')


class AppModuleDrawables(unittest.TestCase):
    """S70 SX8, S20 SC20 and S70 11 d: app-module vector drawables with legal names, from pinned inputs only."""

    @classmethod
    def setUpClass(cls):
        cls.outputs = g.generate(g.ROOT)

    def test_inventory_and_legal_resource_names(self):
        names = sorted(p.name for p in self.outputs if p.parent == g.DRAWABLES)
        self.assertEqual(names, sorted(n + '.xml' for n in [
            'conclave_mic_fill1', 'conclave_mic_off_fill1', 'conclave_call_end_fill1',
            'conclave_cancel_presentation_fill1', 'conclave_ic_stat',
            'ic_launcher_foreground', 'ic_launcher_monochrome']))
        for name in names:
            self.assertRegex(name, r'^[a-z][a-z0-9_]*\.xml$')
        for bad in ['MicFill1', 'mic-fill', '1mic', 'mic.fill1', '', 'conclave_Mic']:
            with self.subTest(bad=bad), self.assertRaises(g.IconError):
                g.drawable_name(bad)

    def test_system_drawables_are_the_selected_material_artwork(self):
        # Consistency, not an oracle: the drawable a notification or PiP action shows is the same converted
        # geometry as the Compose ImageVector for that artwork, as plain 24 dp white single paths.
        for name, prop in [('conclave_mic_fill1', 'MicFill1'), ('conclave_mic_off_fill1', 'MicOffFill1'),
                           ('conclave_call_end_fill1', 'CallEndFill1'),
                           ('conclave_cancel_presentation_fill1', 'CancelPresentationFill1')]:
            with self.subTest(name=name):
                xml = drawable(self.outputs, name)
                self.assertEqual(xml.count('<path'), 1)
                self.assertEqual((xml_attr(xml, 'android:width'), xml_attr(xml, 'android:height')), ('24dp', '24dp'))
                self.assertEqual((xml_attr(xml, 'android:viewportWidth'), xml_attr(xml, 'android:viewportHeight')),
                                 ('960', '960'))
                self.assertEqual(xml_attr(xml, 'android:fillColor'), '#FFFFFFFF')
                self.assertNotIn('autoMirrored', xml)
                self.assertNotIn('<group', xml)
                data = xml_attr(xml, 'android:pathData')
                self.assertRegex(data, r'^M[-0-9. ,MLQZ]*Z$')
                numbers = [F(n) for n in re.findall(r'-?[0-9][0-9.]*', data)]
                self.assertEqual(numbers, kotlin_vector_numbers(prop))
                self.assertIn('Material Symbols by Google', xml)

    def test_status_icon_is_the_letterless_diamond_in_the_live_area(self):
        xml = drawable(self.outputs, 'conclave_ic_stat')
        brand = g.parse_brand_mark((g.ROOT / g.BRAND_MARK).read_bytes())
        self.assertEqual(xml.count('<path'), 1)
        data = xml_attr(xml, 'android:pathData')
        self.assertEqual(data, brand['subpaths'][0])
        self.assertEqual(data.count('M'), 1)
        for letter in brand['subpaths'][1:]:
            self.assertNotIn(letter, xml)
        self.assertEqual(xml_attr(xml, 'android:fillColor'), '#FFFFFFFF')
        self.assertNotIn('fillType', xml)
        # The drawn diamond (curve extent of the parsed path, placed by the parsed group translation) spans the
        # 20 dp live area of the 24 dp canvas with a 2 dp margin on every side.
        width, height = xml_attr(xml, 'android:width'), xml_attr(xml, 'android:height')
        self.assertEqual((width, height), ('24dp', '24dp'))
        size = F(width[:-2])
        viewport = F(xml_attr(xml, 'android:viewportWidth'))
        self.assertEqual(viewport, F(xml_attr(xml, 'android:viewportHeight')))
        dp = size / viewport
        (left, right), (top, bottom) = curve_extent(data)
        for low, high, offset in [(left, right, F(xml_attr(xml, 'android:translateX'))),
                                  (top, bottom, F(xml_attr(xml, 'android:translateY')))]:
            self.assertLess(abs((high - low) * dp - 20), F(1, 100))
            self.assertLess(abs((offset + low) * dp - 2), F(1, 100))
            self.assertLess(abs((viewport - offset - high) * dp - 2), F(1, 100))

    def test_launcher_layers_share_one_knockout_path_inside_the_safe_zone(self):
        brand = g.parse_brand_mark((g.ROOT / g.BRAND_MARK).read_bytes())
        full = ''.join(brand['subpaths'])
        layers = {name: drawable(self.outputs, name) for name in ['ic_launcher_foreground', 'ic_launcher_monochrome']}
        for name, xml in layers.items():
            with self.subTest(name=name):
                self.assertEqual(xml.count('<path'), 1)
                self.assertEqual(xml_attr(xml, 'android:pathData'), full)
                self.assertEqual(xml_attr(xml, 'android:fillType'), 'evenOdd')
                self.assertEqual((xml_attr(xml, 'android:width'), xml_attr(xml, 'android:viewportWidth')), ('108dp', '108'))
                scale = F(xml_attr(xml, 'android:scaleX'))
                self.assertEqual(scale, F(xml_attr(xml, 'android:scaleY')))
                offset = F(xml_attr(xml, 'android:translateX'))
                self.assertEqual(offset, F(xml_attr(xml, 'android:translateY')))
                # The 400 unit diamond becomes 66 dp, centred: its tips touch the 66 dp safe-zone circle.
                self.assertEqual(scale * 400, 66)
                self.assertEqual(offset * 2 + 66, 108)
        self.assertEqual(xml_attr(layers['ic_launcher_monochrome'], 'android:fillColor'), '#FFFFFFFF')
        self.assertEqual(xml_attr(layers['ic_launcher_foreground'], 'android:fillColor'), '#FF' + brand['fill'][1:])
        self.assertEqual(brand['fill'], '#F95F4A')
        self.assertEqual(len(brand['subpaths']), 5)

    def test_wordmark_stand_in_is_withheld(self):
        # Review F3 and ISSUE 1: the icon mark is not a "Conclave" wordmark, so no output ships under that name
        # and the S10 R2 plain-title fallback stays until owner-approved outlined lettering exists.
        self.assertNotIn(g.DRAWABLES / 'conclave_wordmark.xml', self.outputs)
        self.assertEqual([p for p in self.outputs if 'wordmark' in str(p).lower()], [])
        full = ''.join(g.parse_brand_mark((g.ROOT / g.BRAND_MARK).read_bytes())['subpaths'])
        holders = sorted(p.name for p, data in self.outputs.items() if full.encode() in data)
        self.assertEqual(holders, ['conclave-mark.svg', 'ic_launcher_foreground.xml', 'ic_launcher_monochrome.xml'])

    def test_every_drawable_is_flat_generated_and_dash_free(self):
        for path, data in self.outputs.items():
            if path.parent != g.DRAWABLES:
                continue
            text = data.decode()
            with self.subTest(path=path.name):
                self.assertTrue(text.startswith('<?xml version="1.0" encoding="utf-8"?>\n<!-- ' + g.GENERATED_MARK))
                self.assertNotRegex(text.lower(), r'gradient|<aapt:attr|<clip-path|stroke')
                self.assertEqual(len(re.findall(r'android:fillColor="(#[0-9A-F]{8})"', text)), 1)
                for forbidden in [chr(0x2013), chr(0x2014), '\r', '/Users/']:
                    self.assertNotIn(forbidden, text)

    def test_brand_source_is_pinned_and_parsed_strictly(self):
        self.assertEqual(g.digest((g.ROOT / g.BRAND_MARK).read_bytes()), g.BRAND_MARK_SHA)
        parsed = g.parse_brand_mark(BRAND_FIXTURE)
        self.assertEqual(parsed, {'fill': '#F95F4A', 'subpaths': ['M200 0L400 200L200 400L0 200Z', 'M150 180H250V220H150Z']})
        bad = {
            'relative command': BRAND_FIXTURE.replace(b'L400 200', b'l200 200'),
            'curve family outside profile': BRAND_FIXTURE.replace(b'L400 200', b'A1 1 0 0 1 400 200'),
            'second path': BRAND_FIXTURE.replace(b'</svg>', b'<path d="M0 0Z" fill="#000000"/></svg>'),
            'gradient paint': BRAND_FIXTURE.replace(b'fill="#F95F4A"', b'fill="url(#g)"'),
            'gradient element': BRAND_FIXTURE.replace(b'</svg>', b'<linearGradient id="g"/></svg>'),
            'nonzero rule': BRAND_FIXTURE.replace(b'fill-rule="evenodd"', b'fill-rule="nonzero"'),
            'other canvas': BRAND_FIXTURE.replace(b'viewBox="0 0 400 400"', b'viewBox="0 0 24 24"'),
            'letters missing': BRAND_FIXTURE.replace(b'M150 180H250V220H150Z', b''),
            'open subpath': BRAND_FIXTURE.replace(b'L0 200Z', b'L0 200'),
            'entity': BRAND_FIXTURE.replace(b'M200 0', b'M200&#48;'),
        }
        for name, data in bad.items():
            with self.subTest(case=name), self.assertRaises(g.IconError):
                g.parse_brand_mark(data)
        read = Path.read_bytes

        def tampered(path):
            data = read(path)
            return data + b' ' if path == g.ROOT / g.BRAND_MARK else data
        with patch.object(Path, 'read_bytes', tampered), self.assertRaises(g.IconError):
            g.generate(g.ROOT)

    def test_drawable_drift_and_extras_only_count_generated_files(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / g.ICON).mkdir(parents=True)
            outputs = {g.DRAWABLES / 'conclave_mic_fill1.xml': b'<!-- ' + g.GENERATED_MARK.encode() + b' -->\n'}
            g.publish(root, outputs)
            self.assertEqual(g.publish(root, outputs, check=True), [])
            folder = root / g.DRAWABLES
            (folder / 'hand_written.xml').write_bytes(b'<vector/>\n')
            self.assertEqual(g.publish(root, outputs, check=True), [])
            (folder / 'conclave_retired.xml').write_bytes(b'<!-- ' + g.GENERATED_MARK.encode() + b'; do not edit. -->\n')
            with self.assertRaises(g.IconError):
                g.publish(root, outputs, check=True)


def sandbox(td):
    """A copy of every generator input and output folder under a temporary root."""
    root = Path(td)
    for rel in [g.ICON, g.ANDROID, g.IOS, g.APP_ICON, g.CALLKIT_ICON]:
        shutil.copytree(g.ROOT / rel, root / rel)
    (root / g.DRAWABLES).mkdir(parents=True)
    for path in (g.ROOT / g.DRAWABLES).glob('*.xml'):
        shutil.copyfile(path, root / g.DRAWABLES / path.name)
    for rel in [g.IOS_LICENSE, g.ANDROID_LICENSE, g.TOKEN_COLORS]:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(g.ROOT / rel, root / rel)
    return root


def curve_extent(subpath, steps=64):
    """x and y extent of an absolute M/C/L/H/V/Z path; cubic segments are sampled at k/steps (exact rationals)."""
    xs, ys, x, y = [], [], F(0), F(0)
    for command, numbers in re.findall(r'([MCLHVZ])([^MCLHVZ]*)', subpath):
        values = [F(n) for n in g.NUMBER.findall(numbers)]
        if command in 'ML':
            for i in range(0, len(values), 2):
                x, y = values[i], values[i + 1]
                xs.append(x)
                ys.append(y)
        elif command in 'HV':
            for value in values:
                x, y = (value, y) if command == 'H' else (x, value)
                xs.append(x)
                ys.append(y)
        elif command == 'C':
            for i in range(0, len(values), 6):
                x1, y1, x2, y2, x3, y3 = values[i:i + 6]
                for k in range(steps + 1):
                    t = F(k, steps)
                    u = 1 - t
                    xs.append(u ** 3 * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3)
                    ys.append(u ** 3 * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3)
                x, y = x3, y3
    return (min(xs), max(xs)), (min(ys), max(ys))


def token_tile():
    """The launcher tile color as gen-native-tokens wrote it, read without the generator under test."""
    text = (g.ROOT / g.TOKEN_COLORS).read_text()
    found = re.findall(r'<color name="ic_launcher_background">#FF([0-9A-F]{6})</color>', text)
    assert len(found) == 1, found
    return '#' + found[0]


def srgb_text(hex6):
    return 'srgb:' + ','.join('%.5f' % (int(hex6[i:i + 2], 16) / 255) for i in (1, 3, 5)) + ',1.00000'


class DarwinBrandAssets(unittest.TestCase):
    """S70 SX9 and 11 c (review F4): the Icon Composer document and the CallKit template are generated from the
    pinned mark and the generated launcher tile color, so a changed input regenerates them and --check fails on a
    stale or extra file in either folder."""

    @classmethod
    def setUpClass(cls):
        cls.outputs = g.generate(g.ROOT)
        cls.brand = g.parse_brand_mark((g.ROOT / g.BRAND_MARK).read_bytes())

    def test_inventory(self):
        self.assertEqual(sorted(p for p in self.outputs if g.APP_ICON in p.parents),
                         [g.APP_ICON / 'Assets/acm-letters.svg', g.APP_ICON / 'Assets/conclave-mark.svg',
                          g.APP_ICON / 'icon.json'])
        self.assertEqual(sorted(p for p in self.outputs if g.CALLKIT_ICON in p.parents),
                         [g.CALLKIT_ICON / 'CallKitIcon.svg', g.CALLKIT_ICON / 'Contents.json'])

    def test_icon_document_uses_solid_fills_and_hides_the_letters_in_mono(self):
        text = self.outputs[g.APP_ICON / 'icon.json'].decode()
        self.assertNotIn('gradient', text.lower())
        document = json.loads(text)
        ink = {'solid': srgb_text(token_tile())}
        self.assertEqual(document['fill-specializations'], [{'value': ink}, {'appearance': 'dark', 'value': ink}])
        self.assertNotIn('fill', document)
        self.assertEqual(document['supported-platforms'], {'squares': 'shared'})
        group, = document['groups']
        self.assertEqual(group['shadow']['kind'], 'none')
        self.assertIs(group['translucency']['enabled'], False)
        letters, mark = group['layers']
        self.assertEqual((letters['name'], letters['image-name']), ('Letters', 'acm-letters.svg'))
        self.assertEqual((mark['name'], mark['image-name']), ('Mark', 'conclave-mark.svg'))
        self.assertEqual(letters['fill'], ink)
        self.assertEqual(mark['fill'], {'solid': srgb_text(self.brand['fill'])})
        self.assertIs(letters['glass'], False)
        self.assertIs(mark['glass'], False)
        self.assertEqual(letters['hidden-specializations'], [{'appearance': 'tinted', 'value': True}])
        self.assertNotIn('hidden-specializations', mark)

    def test_layers_carry_the_pinned_path_at_todays_placement(self):
        subpaths = self.brand['subpaths']
        for name, path, fill in [('conclave-mark.svg', ''.join(subpaths), self.brand['fill']),
                                 ('acm-letters.svg', ''.join(subpaths[1:]), token_tile())]:
            with self.subTest(name=name):
                svg = self.outputs[g.APP_ICON / 'Assets' / name].decode()
                self.assertEqual(svg.count('<path'), 1)
                self.assertEqual(xml_attr(svg, 'd'), path)
                self.assertEqual(xml_attr(svg, 'fill'), fill)
                self.assertEqual(xml_attr(svg, 'fill-rule'), 'evenodd')
                self.assertEqual((xml_attr(svg, 'width'), xml_attr(svg, 'viewBox')), ('1024', '0 0 1024 1024'))
                offset_x, offset_y, scale = (F(n) for n in re.fullmatch(
                    r'translate\(([0-9.]+) ([0-9.]+)\) scale\(([0-9.]+)\)', xml_attr(svg, 'transform')).groups())
                # The 400 unit mark becomes today's 860 px diamond, centred on the 1024 px canvas.
                self.assertEqual((offset_x, scale * 400, offset_x * 2 + scale * 400), (offset_y, 860, 1024))

    def test_callkit_template_is_the_letterless_diamond_vector(self):
        svg = self.outputs[g.CALLKIT_ICON / 'CallKitIcon.svg'].decode()
        diamond = self.brand['subpaths'][0]
        self.assertEqual(svg.count('<path'), 1)
        self.assertEqual(xml_attr(svg, 'd'), diamond)
        for letter in self.brand['subpaths'][1:]:
            self.assertNotIn(letter, svg)
        # Template art: the system draws alpha only, so the path keeps SVG's default paint (no color, one color).
        self.assertNotIn('fill', svg)
        self.assertNotRegex(svg.lower(), r'gradient|stroke|opacity')
        self.assertEqual((xml_attr(svg, 'width'), xml_attr(svg, 'height')), ('40', '40'))
        self.assertEqual(xml_attr(svg, 'viewBox'), '0 0 400 400')
        # S70 11 c: the diamond fills the 40 pt square.
        (left, right), (top, bottom) = curve_extent(diamond)
        for low, high in [(left, right), (top, bottom)]:
            self.assertLess(abs(low), F(1, 100))
            self.assertLess(abs(high - 400), F(1, 100))
        contents = json.loads(self.outputs[g.CALLKIT_ICON / 'Contents.json'])
        self.assertEqual(contents['images'], [{'filename': 'CallKitIcon.svg', 'idiom': 'universal'}])
        self.assertEqual(contents['properties'], {'template-rendering-intent': 'template'})

    def test_tile_is_the_generated_launcher_color(self):
        self.assertEqual(g.launcher_tile(g.ROOT), token_tile())
        line = re.compile(r'(<color name="ic_launcher_background">)#FF[0-9A-F]{6}(</color>)')
        with tempfile.TemporaryDirectory() as td:
            root = sandbox(td)
            colors = root / g.TOKEN_COLORS
            original = colors.read_text()
            colors.write_text(line.sub(r'\g<1>#FF101012\g<2>', original))
            document = g.generate(root)[g.APP_ICON / 'icon.json'].decode()
            self.assertIn(srgb_text('#101012'), document)
            self.assertNotIn(srgb_text(token_tile()), document)
            broken = {
                'hand edited': original.replace('GENERATED by packages/ui-tokens/scripts/gen-native-tokens.mjs', 'Edited'),
                'missing': line.sub('', original),
                'duplicate': original.replace('</resources>', line.search(original).group(0) + '\n</resources>'),
                'translucent': line.sub(r'\g<1>#800A0A0B\g<2>', original),
            }
            for case, text in broken.items():
                colors.write_text(text)
                with self.subTest(case=case), self.assertRaises(g.IconError):
                    g.generate(root)

    def test_stale_and_extra_darwin_files_fail_the_check(self):
        for rel in [g.CALLKIT_ICON / 'CallKitIcon.png', g.CALLKIT_ICON / 'CallKitIcon@2x.png',
                    g.APP_ICON / 'Assets/stray.svg', g.APP_ICON / 'icon.json']:
            with self.subTest(rel=str(rel)), tempfile.TemporaryDirectory() as td:
                root = sandbox(td)
                (root / rel).write_bytes(b'x')
                with self.assertRaises(g.IconError):
                    g.publish(root, g.generate(root), check=True)


class FinderMetadata(unittest.TestCase):
    """Review D3: a Finder .DS_Store is never an input or an output, so it cannot fail validation or drift."""

    def sandbox(self, td):
        return sandbox(td)

    def test_ds_store_in_inputs_evidence_and_outputs_is_ignored(self):
        with tempfile.TemporaryDirectory() as td:
            root = self.sandbox(td)
            folders = [g.VENDOR, g.VENDOR / 'assets/symbols/web/send', g.EVIDENCE, g.ANDROID, g.IOS, g.BRAND, g.DRAWABLES,
                       g.APP_ICON, g.APP_ICON / 'Assets', g.CALLKIT_ICON]
            for folder in folders:
                (root / folder / '.DS_Store').write_bytes(b'\x00\x00\x00\x01Bud1')
            outputs = g.generate(root)
            self.assertEqual(outputs, g.generate(g.ROOT))
            self.assertEqual(g.publish(root, outputs, check=True), [])
            self.assertEqual(g.publish(root, outputs), [])
            for folder in folders:
                self.assertTrue((root / folder / '.DS_Store').is_file())

    def test_other_stray_files_still_fail(self):
        for folder, name in [(g.VENDOR, 'stray.svg'), (g.EVIDENCE, 'stray.json'), (g.ANDROID, 'Stray.kt'),
                             (g.IOS, '.DS_Store.swift'), (g.BRAND, 'stray.svg'), (g.CALLKIT_ICON, 'stray.png')]:
            with self.subTest(folder=str(folder), name=name), tempfile.TemporaryDirectory() as td:
                root = self.sandbox(td)
                (root / folder / name).write_bytes(b'x')
                with self.assertRaises(g.IconError):
                    g.publish(root, g.generate(root), check=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
